'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function between(start, end) {
  const first = html.indexOf(start), last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return html.slice(first, last);
}
const source = [
  between('const JFS_JOB_TYPES = {', '\nfunction jobTypeOptions'),
  between('let WAI = ', '\nfunction waiResetJobInputs'),
  between('async function waiLoad(silent)', '\nfunction waiBadge'),
].join('\n');
const copy = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ note = null, status = 'NEW' } = {}) {
  const row = { id: 'inbox-1', job_no: 'AEXP-C00468', note, status, updated_at: 'unchanged' };
  const db = { row: copy(row) }, hooks = {}, calls = { reads: 0, writes: [], lists: 0, renders: 0 };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '' });
    return elements.get(id);
  };
  function query(mode, payload) {
    const filters = [];
    const q = {
      select() { return q; },
      eq(key, value) { filters.push({ op: 'eq', key, value }); return q; },
      is(key, value) { filters.push({ op: 'is', key, value }); return q; },
      order() { return q; }, limit() { return q; }, in() { return q; },
      async maybeSingle() {
        if (mode === 'read') {
          calls.reads++;
          return hooks.read ? hooks.read() : { data: { id: db.row.id, note: db.row.note }, error: null };
        }
        if (hooks.beforeWrite) await hooks.beforeWrite();
        if (hooks.writeError) return { data: null, error: { message: hooks.writeError } };
        if (!filters.every(({ key, value }) => db.row[key] === value)) return { data: null, error: null };
        Object.assign(db.row, payload);
        return { data: { id: db.row.id, note: db.row.note }, error: null };
      },
      then(resolve, reject) {
        calls.lists++;
        return Promise.resolve().then(() => hooks.list ? hooks.list() : { data: [copy(db.row)], error: null }).then(resolve, reject);
      },
    };
    if (mode === 'write') calls.writes.push({ payload: copy(payload), filters });
    return q;
  }
  const context = {
    console,
    document: { getElementById: element },
    sbUser: { id: 'staff-a', email: 'a@example.test' },
    sb: { from(table) {
      assert.equal(table, 'dg_inbox');
      return { select: () => query('read'), update: payload => query('write', payload) };
    } },
    waiBadge() {}, waiRender() { calls.renders++; },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.initialRows = [copy(row)];
  vm.runInContext('WAI.rows = initialRows;', context);
  return {
    context, db, hooks, calls, element,
    evaluate: code => vm.runInContext(code, context),
    state: code => copy(vm.runInContext(code, context)),
    choose: code => { context.selectedCode = code; return vm.runInContext('waiChooseType("inbox-1", selectedCode)', context); },
    load: () => vm.runInContext('waiLoad(true)', context),
  };
}

test('a type selection persists a null note without marking the job opened or changing shipment timestamps', async () => {
  const h = harness();
  assert.equal(await h.choose('DGS'), true);
  assert.deepEqual(h.calls.writes[0].payload, { note: 'Job type: DGS' });
  assert.deepEqual(h.calls.writes[0].filters, [{ op: 'eq', key: 'id', value: 'inbox-1' }, { op: 'is', key: 'note', value: null }]);
  assert.equal(h.db.row.status, 'NEW');
  assert.equal(h.db.row.updated_at, 'unchanged');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'DGS');
  assert.equal(h.state('WAI.typeStatus["inbox-1"]').message, 'Saved');
  assert.equal(h.element('wai_type_inbox-1').disabled, false);
});

test('selection reads the latest note and preserves unrelated staff edits', async () => {
  const h = harness({ note: 'Old cached note.\nJob type: AEXP', status: 'DONE' });
  h.db.row.note = 'Latest customer instruction.\nJob type: AIMP\nKeep consignee unchanged.';
  assert.equal(await h.choose('ELI'), true);
  assert.equal(h.db.row.note, 'Latest customer instruction.\nKeep consignee unchanged.\nJob type: ELI');
  assert.equal(h.calls.writes[0].filters[1].value, 'Latest customer instruction.\nJob type: AIMP\nKeep consignee unchanged.');
  assert.equal(h.db.row.status, 'DONE');
});

test('pending save disables the selector and rejects an overlapping change on the same job', async () => {
  const h = harness(), read = deferred();
  h.hooks.read = () => read.promise;
  const pending = h.choose('DGS');
  assert.equal(h.element('wai_type_inbox-1').disabled, true);
  assert.match(h.element('wai_dest_inbox-1').textContent, /Saving/);
  assert.equal(await h.choose('GEN'), false);
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.writes.length, 0);
  read.resolve({ data: { id: 'inbox-1', note: null }, error: null });
  assert.equal(await pending, true);
  assert.equal(h.db.row.note, 'Job type: DGS');
});

test('failed write rolls the selector back and never displays Saved', async () => {
  const h = harness({ note: 'Keep this note.\nJob type: AEXP' });
  h.hooks.writeError = 'Permission denied';
  assert.equal(await h.choose('DGS'), false);
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'AEXP');
  assert.equal(h.element('wai_type_inbox-1').value, 'AEXP');
  assert.equal(h.element('wai_type_inbox-1').disabled, false);
  assert.match(h.element('wai_dest_inbox-1').textContent, /Not saved.*Permission denied/);
  assert.equal(h.db.row.note, 'Keep this note.\nJob type: AEXP');
  assert.equal(h.calls.lists, 0);
});

test('a competing note change prevents a stale classification write', async () => {
  const h = harness({ note: 'Job type: AEXP' });
  h.hooks.beforeWrite = () => { h.db.row.note = 'New staff note.\nJob type: GEN'; };
  assert.equal(await h.choose('DGS'), false);
  assert.equal(h.db.row.note, 'New staff note.\nJob type: GEN');
  assert.match(h.element('wai_dest_inbox-1').textContent, /Not saved.*changed while saving/);
  await h.load();
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'GEN');
});

test('refresh uses saved classification rather than retaining an old unsaved local selection', async () => {
  const h = harness();
  h.evaluate('WAI.types["inbox-1"] = "DGS"');
  await h.load();
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'AEXP');
  assert.deepEqual(h.state('WAI.types'), {});
});

test('confirmed save updates a row replaced by a refresh even when the following reload fails', async () => {
  const h = harness(), write = deferred();
  h.hooks.beforeWrite = () => write.promise;
  const pending = h.choose('DGS');
  await new Promise(resolve => setImmediate(resolve));
  await h.load(); // Replace the captured row with a fresh object while save is waiting.
  h.hooks.list = () => ({ data: null, error: { message: 'Refresh unavailable' } });
  write.resolve();
  assert.equal(await pending, true);
  assert.equal(h.state('WAI.rows[0]').note, 'Job type: DGS');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'DGS');
  assert.equal(h.state('WAI.typeStatus["inbox-1"]').message, 'Saved');
});

test('network failure during post-save refresh does not falsely roll back a database-confirmed type', async () => {
  const h = harness();
  h.hooks.list = () => { throw new Error('Network unavailable'); };
  assert.equal(await h.choose('DGS'), true);
  assert.equal(h.db.row.note, 'Job type: DGS');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'DGS');
  assert.equal(h.state('WAI.typeStatus["inbox-1"]').message, 'Saved');
  assert.match(h.element('wai_msg').textContent, /Job type saved.*refresh failed/);
});

test('a refresh result from a previous signed-in account is discarded', async () => {
  const h = harness(), list = deferred();
  h.hooks.list = () => list.promise;
  const pending = h.load();
  await new Promise(resolve => setImmediate(resolve));
  h.context.sbUser = { id: 'staff-b', email: 'b@example.test' };
  list.resolve({ data: [{ id: 'another-job', note: 'Job type: DGS' }], error: null });
  await pending;
  assert.equal(h.state('WAI.rows[0]').id, 'inbox-1');
  assert.equal(h.calls.renders, 0);
});

test('a newer refresh wins if older queries return out of order', async () => {
  const h = harness(), first = deferred(), second = deferred();
  let index = 0;
  h.hooks.list = () => (++index === 1 ? first.promise : second.promise);
  const oldLoad = h.load(), newLoad = h.load();
  await new Promise(resolve => setImmediate(resolve));
  second.resolve({ data: [{ ...h.db.row, note: 'Job type: ELM' }], error: null });
  await newLoad;
  first.resolve({ data: [{ ...h.db.row, note: 'Job type: GEN' }], error: null });
  await oldLoad;
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'ELM');
});

test('an account change before latest-note lookup finishes prevents the classification write', async () => {
  const h = harness(), read = deferred();
  h.hooks.read = () => read.promise;
  const pending = h.choose('DGS');
  h.context.sbUser = { id: 'staff-b', email: 'b@example.test' };
  read.resolve({ data: { id: 'inbox-1', note: null }, error: null });
  assert.equal(await pending, false);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.db.row.note, null);
});
