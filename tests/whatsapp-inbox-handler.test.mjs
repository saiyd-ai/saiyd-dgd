import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createInboxHandler, OPEN_MIN } from '../supabase/functions/dg-inbox/inbox-handler.mjs';
const require = createRequire(import.meta.url);
const { PDF, JPEG, PNG, workbookZip, workbookCfb } = require('./helpers/whatsapp-media-fixtures.cjs');
const OWNER = '971562977774', KEY = 'synthetic-test-key-only';
const NOW = '2026-10-11T12:00:00.000Z';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLS = 'application/vnd.ms-excel';
const row = (id, changes = {}) => ({ id, sender: OWNER, sender_name: 'Synthetic owner', job_no: 'AEXP-C00422', status: 'NEW',
  message: 'Existing shipment details', files: [], note: 'Job type: AEXP', wa_message_ids: [],
  created_at: '2026-10-11T10:30:00.000Z', updated_at: '2026-10-11T11:45:00.000Z', ...changes });
const fileBody = (id = 'media-1', { bytes = PDF, mime = 'application/pdf', name = 'synthetic.pdf', caption = 'Synthetic attachment caption', ...extra } = {}) =>
  ({ from: OWNER, type: 'document', message_id: id, caption, file: { name, mime, base64: bytes.toString('base64') }, ...extra });

// Model the Supabase query contract and, separately, the row-locked RPC. Reads
// return snapshots so a regression to read/replace JSONB fails the burst test.
function database(initial = [], options = {}) {
  const rows = structuredClone(initial), uploads = new Map(), removed = [], queries = [], appends = [], locks = new Map();
  let serial = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.kind = 'read'; }
    select() { return this; }
    eq(key, value) { this.filters.push(['eq', key, value]); return this; }
    is(key, value) { this.filters.push(['eq', key, value]); return this; }
    in(key, value) { this.filters.push(['in', key, value]); return this; }
    gte(key, value) { this.filters.push(['gte', key, value]); return this; }
    order(key, opts) { this.orders.push([key, opts.ascending]); return this; }
    limit(value) { this.max = value; return this; }
    insert(value) { this.kind = 'insert'; this.value = value; return this; }
    update() { throw new Error('Direct read/replace updates are forbidden; use the atomic RPC'); }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      queries.push({ table: this.table, kind: this.kind, filters: structuredClone(this.filters), orders: structuredClone(this.orders) });
      if (this.table === 'dg_staff_numbers') return { data: options.inactive ? null : { name: 'Synthetic owner', active: true }, error: options.staffError || null };
      assert.equal(this.table, 'dg_inbox');
      if (this.kind === 'insert') {
        if (options.insertError) return { data: null, error: new Error('Synthetic insertion failure') };
        const item = row('created-' + ++serial, { message: null, note: null, ...this.value, created_at: NOW });
        rows.push(item); return { data: structuredClone(item), error: null };
      }
      if (options.readError) return { data: null, error: new Error('Synthetic lookup failure') };
      let found = rows.filter(r => this.filters.every(([op, key, value]) => op === 'eq' ? r[key] === value : op === 'in' ? value.includes(r[key]) : r[key] >= value));
      found.sort((a, b) => { for (const [key, asc] of this.orders) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (asc ? 1 : -1); } return 0; });
      if (this.max !== undefined) found = found.slice(0, this.max);
      return { data: structuredClone(this.one ? found[0] || null : found), error: null };
    }
  }
  const sb = {
    from: table => new Query(table),
    storage: { from: bucket => { assert.equal(bucket, 'dgdocs'); return {
      async upload(path, bytes, args) {
        if (options.uploadError) return { error: new Error('Synthetic upload failure') };
        uploads.set(path, { bytes: Buffer.from(bytes), args }); return { error: null };
      },
      async remove(paths) { removed.push(...paths); for (const p of paths) uploads.delete(p); return { error: null }; },
    }; } },
    async rpc(name, params) {
      assert.equal(name, 'dg_inbox_append_whatsapp'); appends.push(structuredClone(params));
      const previous = locks.get(params.p_id) || Promise.resolve();
      let unlock; const current = new Promise(resolve => { unlock = resolve; }); locks.set(params.p_id, current);
      await previous;
      try {
        await new Promise(resolve => setImmediate(resolve));
        if (options.beforeAppend) options.beforeAppend(rows, params);
        if (options.rpcError) return { data: null, error: new Error('Synthetic append failure') };
        const target = rows.find(r => r.id === params.p_id && r.sender === params.p_sender);
        if (!target || !['NEW', 'OPENED'].includes(target.status) || target.updated_at < new Date(Date.parse(params.p_at) - OPEN_MIN * 60000).toISOString() ||
            (params.p_job_no && target.job_no && params.p_job_no !== target.job_no)) return { data: null, error: new Error('Inactive/mismatched row') };
        if (params.p_message_id && target.wa_message_ids.includes(params.p_message_id)) return { data: { row: structuredClone(target), duplicate: true }, error: null };
        target.job_no ||= params.p_job_no;
        if (params.p_text) target.message = [target.message, params.p_text].filter(Boolean).join('\n');
        if (params.p_file) target.files.push(structuredClone(params.p_file));
        if (params.p_message_id) target.wa_message_ids.push(params.p_message_id);
        if (target.updated_at < params.p_at) target.updated_at = params.p_at;
        return { data: { row: structuredClone(target), duplicate: false }, error: null };
      } finally { unlock(); }
    },
  };
  const handler = createInboxHandler({ sb, getKey: async () => KEY, now: () => new Date(NOW), newId: () => 'unique-' + ++serial });
  async function send(body, key = KEY) {
    const response = await handler(new Request('https://example.invalid/dg-inbox', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-key': key }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  }
  return { rows, uploads, removed, queries, appends, handler, send };
}

test('job command without a file opens a job, records the command once, and acknowledges it', async () => {
  const db = database();
  const result = await db.send({ from: OWNER, type: 'text', text: 'DG TEST-C00001', message_id: 'command-1' });
  assert.equal(result.status, 200); assert.match(result.body.reply, /job TEST-C00001 opened/);
  assert.equal(db.rows.length, 1); assert.equal(db.rows[0].message, 'DG TEST-C00001');
  assert.equal(db.rows[0].status, 'NEW'); assert.deepEqual(db.rows[0].files, []); assert.equal(db.uploads.size, 0);
  assert.deepEqual(db.rows[0].wa_message_ids, ['command-1']);
});

test('PDF caption and existing text stay on the latest OPENED job without changing its status or note', async () => {
  const db = database([row('old-new', { job_no: 'DGS-C00300', updated_at: '2026-10-11T11:40:00.000Z' }), row('latest-opened', { status: 'OPENED' })]);
  const result = await db.send(fileBody());
  assert.equal(result.body.job_no, 'AEXP-C00422'); assert.equal(result.body.files, 1);
  assert.deepEqual(db.rows[0].files, []);
  const target = db.rows[1]; assert.equal(target.status, 'OPENED'); assert.equal(target.note, 'Job type: AEXP');
  assert.equal(target.message, 'Existing shipment details\nSynthetic attachment caption');
  assert.equal(target.files[0].caption, 'Synthetic attachment caption'); assert.equal(target.files[0].message_id, 'media-1');
  assert.equal(target.updated_at, NOW); assert.match(target.files[0].path, /^wa-inbox\/latest-opened\//);
  const query = db.queries.find(q => q.table === 'dg_inbox');
  assert.deepEqual(query.filters.find(f => f[0] === 'in'), ['in', 'status', ['NEW', 'OPENED']]);
  assert.deepEqual(query.filters.find(f => f[0] === 'gte'), ['gte', 'updated_at', '2026-10-11T10:00:00.000Z']);
});

test('server admits PDF, XLSX/XLS, JPG/PNG documents and native image with correct stored MIME', async () => {
  for (const [mime, name, bytes, type] of [
    ['application/pdf', 'a.pdf', PDF, 'document'], [XLSX, 'a.xlsx', workbookZip(), 'document'], [XLS, 'a.xls', workbookCfb(), 'document'],
    ['image/jpeg', 'a.jpeg', JPEG, 'document'], ['image/png', 'a.png', PNG, 'document'], ['image/jpeg', 'photo.jpg', JPEG, 'image'],
  ]) {
    const db = database([row('format')]); const result = await db.send(fileBody('format-' + name, { mime, name, bytes, type }));
    assert.equal(result.status, 200, name); assert.equal(db.rows[0].files[0].mime, mime);
    assert.equal(db.rows[0].files[0].size, bytes.length); assert.equal([...db.uploads.values()][0].args.contentType, mime);
  }
});

test('new unclassified text and media are retained and a later job command assigns that same row', async () => {
  const db = database();
  let result = await db.send({ from: OWNER, type: 'text', text: 'Shipper details for upcoming job', message_id: 'first-text' });
  assert.match(result.body.reply, /Message received/); const id = db.rows[0].id;
  result = await db.send(fileBody()); assert.match(result.body.reply, /File received/); assert.equal(db.rows.length, 1);
  result = await db.send({ from: OWNER, type: 'text', text: 'DG AEXP-C00422', message_id: 'job-command' });
  assert.equal(result.body.job_no, 'AEXP-C00422'); assert.equal(db.rows.length, 1); assert.equal(db.rows[0].id, id);
  assert.equal(db.rows[0].message, 'Shipper details for upcoming job\nSynthetic attachment caption\nDG AEXP-C00422');
  assert.equal(db.rows[0].files.length, 1);
});

test('explicit job command/caption selects the exact older active job rather than another latest named job', async () => {
  const db = database([row('intended', { status: 'OPENED', updated_at: '2026-10-11T11:00:00.000Z' }), row('other-latest', { job_no: 'DGS-C00999' })]);
  const result = await db.send(fileBody('target-file', { caption: 'DG AEXP-C00422' }));
  assert.equal(result.body.job_no, 'AEXP-C00422'); assert.equal(db.rows[0].files.length, 1); assert.equal(db.rows[1].files.length, 0);
  assert.equal(db.rows[0].status, 'OPENED');
});

test('a different explicit job creates its own row and never attaches to an unrelated past or latest named job', async () => {
  const db = database([row('unrelated', { job_no: 'DGS-C00999' }), row('expired', { job_no: 'AEXP-C00422', updated_at: '2026-10-11T09:59:59.999Z' })]);
  const result = await db.send(fileBody('new-job-file', { caption: 'DG AEXP-C00422' }));
  assert.equal(result.body.job_no, 'AEXP-C00422'); assert.equal(db.rows.length, 3);
  assert.equal(db.rows[0].files.length, 0); assert.equal(db.rows[1].files.length, 0); assert.equal(db.rows[2].files.length, 1);
});

test('exact two-hour cutoff includes the boundary and excludes expired or closed rows', async () => {
  const db = database([row('expired', { updated_at: '2026-10-11T09:59:59.999Z' }), row('closed', { status: 'DONE' }),
    row('boundary', { updated_at: '2026-10-11T10:00:00.000Z', status: 'OPENED' })]);
  const result = await db.send({ from: OWNER, type: 'text', text: 'More shipment details', message_id: 'boundary-text' });
  assert.equal(result.body.job_no, 'AEXP-C00422'); assert.equal(db.rows[2].message, 'Existing shipment details\nMore shipment details');
  assert.equal(db.rows[0].message, 'Existing shipment details'); assert.equal(db.rows[1].message, 'Existing shipment details');
});

test('invalid format, MIME, extension, signature, size and base64 never upload or create a row', async () => {
  const invalid = [
    fileBody('bad-mime', { mime: 'application/zip', name: 'a.zip' }), fileBody('bad-name', { name: 'a.exe' }),
    fileBody('bad-signature', { bytes: JPEG }), fileBody('image-workbook', { mime: XLSX, name: 'a.xlsx', bytes: workbookZip(), type: 'image' }),
    fileBody('oversize', { bytes: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 1 - PDF.length)]) }),
    { ...fileBody('bad-base64'), file: { name: 'a.pdf', mime: 'application/pdf', base64: '%PDF-' } },
    { ...fileBody('padding-bits'), file: { name: 'a.pdf', mime: 'application/pdf', base64: 'JR==' } },
  ];
  for (const body of invalid) {
    const db = database(); const result = await db.send(body); assert.equal(result.status, 400, body.message_id);
    assert.equal(db.rows.length, 0); assert.equal(db.uploads.size, 0); assert.equal(db.appends.length, 0);
  }
  const db = database(); const result = await db.send({ from: OWNER, type: 'text', text: 'DG TEST -C00001', message_id: 'bad-command' });
  assert.match(result.body.reply, /Please send the job number/); assert.equal(db.rows.length, 0);
});

test('four simultaneous documents append to current state without losing files or captions', async () => {
  const db = database([row('burst', { status: 'OPENED' })]);
  const results = await Promise.all([1, 2, 3, 4].map(i => db.send(fileBody('burst-' + i, { name: 'part-' + i + '.pdf', caption: 'Part ' + i }))));
  assert.ok(results.every(r => r.status === 200)); assert.equal(db.rows[0].files.length, 4); assert.equal(db.uploads.size, 4);
  assert.deepEqual(new Set(db.rows[0].files.map(f => f.message_id)), new Set(['burst-1', 'burst-2', 'burst-3', 'burst-4']));
  for (const i of [1, 2, 3, 4]) assert.equal(db.rows[0].message.split('\n').filter(t => t === 'Part ' + i).length, 1);
  assert.equal(db.rows[0].status, 'OPENED'); assert.equal(db.rows[0].note, 'Job type: AEXP');
  assert.deepEqual(results.map(r => r.body.files).sort(), [1, 2, 3, 4]);
});

test('simultaneous duplicate deliveries append once and remove the redundant upload', async () => {
  const db = database([row('duplicate')]);
  const results = await Promise.all([db.send(fileBody('same-message')), db.send(fileBody('same-message'))]);
  assert.equal(db.rows[0].files.length, 1); assert.equal(db.uploads.size, 1); assert.equal(db.removed.length, 1);
  assert.equal(db.rows[0].message.split('\n').filter(t => t === 'Synthetic attachment caption').length, 1);
  assert.equal(results.filter(r => r.body.duplicate).length, 1); assert.equal(results.find(r => r.body.duplicate).body.reply, null);
});

test('upload or append failure does not acknowledge receipt and append failure cleans its upload', async () => {
  for (const options of [{ uploadError: true }, { rpcError: true }, { beforeAppend: rows => { rows[0].status = 'DONE'; } }]) {
    const db = database([row('failed')], options); const result = await db.send(fileBody());
    assert.equal(result.status, 500); assert.equal(result.body.reply, undefined); assert.equal(db.rows[0].files.length, 0);
    assert.equal(db.uploads.size, 0); assert.equal(db.rows[0].message, 'Existing shipment details');
  }
});

test('existing header authentication and active staff admission remain required', async () => {
  const db = database([row('secure')]); assert.equal((await db.send(fileBody(), 'wrong-synthetic-key')).status, 401);
  assert.equal(db.queries.length, 0); assert.equal(db.uploads.size, 0);
  const inactive = database([row('secure')], { inactive: true }); assert.deepEqual((await inactive.send(fileBody())).body, { ok: true, dg: false, reply: null });
  assert.equal(inactive.appends.length, 0); assert.equal(inactive.uploads.size, 0);
});

test('deployment migration requires a row lock and service-role-only execution and preserves status/note', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/202610110002_dg_inbox_atomic_whatsapp_append.sql', import.meta.url), 'utf8');
  assert.match(sql, /for update\s*;/i); assert.match(sql, /security definer\s+set search_path = public/i);
  assert.match(sql, /where id = p_id and sender = p_sender/i); assert.match(sql, /interval '120 minutes'/i);
  assert.match(sql, /revoke all on function [^;]+ from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function [^;]+ to service_role;/i);
  assert.match(sql, /jsonb_build_array\(p_file\)/); assert.match(sql, /p_message_id = any\(current_row\.wa_message_ids\)/);
  const update = sql.match(/update public\.dg_inbox[\s\S]+?returning \* into current_row;/i)[0];
  assert.doesNotMatch(update, /(?:status|note|opened_by|opened_at)\s*=/i);
});
