'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const first = html.indexOf('/* Saved server preparations are reviewed separately');
const last = html.indexOf('function exportAll(){', first);
assert.ok(first >= 0 && last > first, 'Saved draft review code exists');
const source = html.slice(first, last);
const INBOX = '11111111-1111-4111-8111-111111111111';
const OTHER_INBOX = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const OTHER_RUN = '44444444-4444-4444-8444-444444444444';
const JOB = 'AEXP-C00465';
const ORIGIN = 'https://jojtqlfhmkvdegqbwvtj.supabase.co';

function run(overrides = {}) {
  const row = {
    id: RUN, inbox_id: INBOX, job_no: JOB, version: 1, status: 'DRAFT_READY',
    delivery_status: 'NOT_SENT', fields: {awb: '020-12345678', shipper: 'Example Trading LLC'},
    missing_fields: [], warnings: [], created_at: '2026-10-11T06:00:00.000Z',
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'artifact_path')) row.artifact_path = `skyd-awb/${row.inbox_id}/v${row.version}-${row.id}.pdf`;
  return row;
}

function harness(options = {}) {
  const elements = new Map();
  const calls = {queries: [], signatures: [], tabs: [], mutations: []};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id, innerHTML: '', textContent: '', disabled: false, value: ''});
    return elements.get(id);
  };
  element('f_job').value = 'EXISTING-C00999';
  element('f_shipper').value = 'Unsaved existing shipper';
  const context = {
    URL, Date, console, SB_URL: ORIGIN,
    document: {getElementById: element},
    sbUser: options.loggedOut ? null : {id: 'staff-id', email: 'staff@example.test'},
    WAI: {rows: [{id: INBOX, job_no: JOB}]},
    showTab: name => calls.tabs.push(name),
    esc: text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    sb: {
      from(table) {
        const request = {table, filters: []};
        calls.queries.push(request);
        const query = {
          select(columns) {request.columns = columns; return query;},
          eq(key, value) {request.filters.push([key, value]); return query;},
          order(key, value) {request.order = [key, value]; return query;},
          limit(limit) {request.limit = limit; return options.query ? options.query(request) : Promise.resolve({data: options.rows || [run()], error: options.error || null});},
        };
        return query;
      },
      storage: {
        from(bucket) {
          return {
            async createSignedUrl(artifact, ttl) {
              calls.signatures.push({bucket, artifact, ttl});
              if (options.sign) return options.sign(artifact, ttl);
              return {data: {signedUrl: options.signedUrl || `${ORIGIN}/storage/v1/object/sign/dgdocs/${artifact}?token=synthetic-token`}, error: options.signError || null};
            },
          };
        },
      },
    },
    jobStart: () => calls.mutations.push('jobStart'),
    applySnapshot: () => calls.mutations.push('applySnapshot'),
    setStore: () => calls.mutations.push('setStore'),
    autosaveCurrent: () => calls.mutations.push('autosaveCurrent'),
    localStorage: {setItem: () => calls.mutations.push('localStorage')},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {context, calls, element, state: () => vm.runInContext('SKYD_DRAFTS', context)};
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

test('draft review requires authentication and does not query or sign private files while signed out', async () => {
  const h = harness({loggedOut: true});
  await h.context.skydDraftLoad(INBOX, JOB);
  await h.context.skydDraftPdf(RUN);
  assert.equal(h.calls.queries.length, 0);
  assert.equal(h.calls.signatures.length, 0);
  assert.match(h.element('skyd_drafts_status').textContent, /Sign in/);
  assert.equal(h.element('skyd_drafts_refresh').disabled, true);
});

test('per-inbox draft action scopes versions to the exact inbox and job without touching the unsaved form', async () => {
  const h = harness({rows: [run(), run({inbox_id: OTHER_INBOX}), run({job_no: 'DGS-C00422'})]});
  await h.context.skydDraftOpen(INBOX);
  assert.deepEqual(h.calls.tabs, ['skyd']);
  assert.equal(h.calls.queries[0].table, 'skyd_awb_runs');
  assert.deepEqual(h.calls.queries[0].filters, [['inbox_id', INBOX], ['job_no', JOB]]);
  assert.equal(h.calls.queries[0].order[0], 'version');
  assert.equal(h.calls.queries[0].order[1].ascending, false);
  assert.equal(h.calls.queries[0].limit, 50);
  assert.equal(h.state().rows.length, 1);
  assert.equal(h.element('f_job').value, 'EXISTING-C00999');
  assert.equal(h.element('f_shipper').value, 'Unsaved existing shipper');
  assert.deepEqual(h.calls.mutations, []);
  assert.equal(h.calls.signatures.length, 0, 'Listing versions never generates a download link automatically');
});

test('ready, missing-input, failed and processing versions stay visible with separate WhatsApp delivery state', async () => {
  const h = harness({rows: [
    run({version: 4, status: 'PROCESSING', artifact_path: null}),
    run({version: 3, id: OTHER_RUN, status: 'NEEDS_INPUT', missing_fields: ['Destination'], warnings: ['Check classification'], artifact_path: null}),
    run({version: 2, status: 'FAILED', error_code: 'FILE_DOWNLOAD_FAILED', artifact_path: null}),
    run({version: 1, delivery_status: 'UNCERTAIN'}),
  ]});
  await h.context.skydDraftLoad(INBOX, JOB);
  const content = h.element('skyd_drafts_list').innerHTML;
  assert.match(content, /AWB draft v4/);
  assert.match(content, /AWB draft v1/);
  assert.match(content, /Preparing draft/);
  assert.match(content, /Needs information \/ review/);
  assert.match(content, /Destination/);
  assert.match(content, /Check classification/);
  assert.match(content, /Preparation failed/);
  assert.match(content, /FILE_DOWNLOAD_FAILED/);
  assert.match(content, /WhatsApp send result needs checking/);
  assert.equal((content.match(/Open draft PDF/g) || []).length, 1);
  assert.match(content, /DRAFT ONLY/);
  assert.doesNotMatch(content, /approved|signed successfully|mark final/i);
});

test('untrusted extracted fields and review warnings are escaped before rendering', async () => {
  const h = harness({rows: [run({fields: {shipper: '<img src=x onerror=alert(1)>', grossWeight: 12.5}, warnings: ['<script>bad()</script>'], missing_fields: ['" onmouseover="bad()']})]});
  await h.context.skydDraftLoad(INBOX, JOB);
  const content = h.element('skyd_drafts_list').innerHTML;
  assert.doesNotMatch(content, /<img|<script>/);
  assert.match(content, /&lt;img/);
  assert.match(content, /&lt;script&gt;/);
  assert.match(content, /&quot; onmouseover=&quot;/);
  assert.match(content, /Gross weight \(kg\).*12\.5/);
});

test('an empty version list gives the exact WhatsApp preparation command and never claims a draft exists', async () => {
  const h = harness({rows: []});
  await h.context.skydDraftLoad(INBOX, JOB);
  assert.match(h.element('skyd_drafts_status').textContent, /No saved SKYD/);
  assert.match(h.element('skyd_drafts_status').textContent, /SKYD PREPARE AEXP-C00465 AWB/);
  assert.equal(h.element('skyd_drafts_list').innerHTML, '');
});

test('a denied query reports the error without presenting stale versions', async () => {
  const h = harness({error: {message: 'permission denied'}});
  await h.context.skydDraftLoad(INBOX, JOB);
  assert.match(h.element('skyd_drafts_status').textContent, /Could not load saved drafts: permission denied/);
  assert.equal(h.state().rows.length, 0);
  assert.equal(h.element('skyd_drafts_list').innerHTML, '');
  assert.equal(h.element('skyd_drafts_refresh').disabled, false);
});

test('a ready version signs only its exact private dgdocs PDF for ten minutes on explicit request', async () => {
  const h = harness();
  await h.context.skydDraftLoad(INBOX, JOB);
  await h.context.skydDraftPdf(RUN);
  assert.deepEqual(h.calls.signatures, [{bucket: 'dgdocs', artifact: `skyd-awb/${INBOX}/v1-${RUN}.pdf`, ttl: 600}]);
  const content = h.element(`skyd_draft_pdf_${RUN}`).innerHTML;
  assert.match(content, /Open AEXP-C00465 AWB draft v1 PDF/);
  assert.match(content, /noopener noreferrer/);
  assert.match(content, /private link expires in 10 minutes/);
  assert.deepEqual(h.calls.mutations, []);
});

test('another job object, a traversal path or the wrong version cannot be signed as a saved draft', async () => {
  for (const artifact of [`wa-inbox/${OTHER_INBOX}/private.pdf`, `skyd-awb/${INBOX}/../private.pdf`, `skyd-awb/${INBOX}/v2-${RUN}.pdf`]) {
    const h = harness({rows: [run({artifact_path: artifact})]});
    await h.context.skydDraftLoad(INBOX, JOB);
    await h.context.skydDraftPdf(RUN);
    assert.equal(h.calls.signatures.length, 0);
    assert.match(h.element(`skyd_draft_pdf_${RUN}`).textContent, /PDF reference is invalid/);
  }
});

test('non-ready drafts do not sign a PDF even if they contain an artifact path', async () => {
  const h = harness({rows: [run({status: 'NEEDS_INPUT'})]});
  await h.context.skydDraftLoad(INBOX, JOB);
  await h.context.skydDraftPdf(RUN);
  assert.equal(h.calls.signatures.length, 0);
});

test('unexpected signed-link origins and paths are rejected instead of becoming clickable', async () => {
  const invalid = [
    'https://attacker.example/file.pdf',
    `${ORIGIN}/storage/v1/object/sign/dgdocs/wa-inbox/${OTHER_INBOX}/private.pdf?token=synthetic`,
    `http://jojtqlfhmkvdegqbwvtj.supabase.co/storage/v1/object/sign/dgdocs/skyd-awb/${INBOX}/v1-${RUN}.pdf`,
  ];
  for (const signedUrl of invalid) {
    const h = harness({signedUrl});
    await h.context.skydDraftLoad(INBOX, JOB);
    await h.context.skydDraftPdf(RUN);
    const box = h.element(`skyd_draft_pdf_${RUN}`);
    assert.equal(box.innerHTML, '');
    assert.match(box.textContent, /Unexpected draft download address/);
  }
});

test('a previous job query cannot replace a newer selected job', async () => {
  const delayed = deferred();
  const h = harness({query: request => request.filters[0][1] === INBOX ? delayed.promise : Promise.resolve({data: [run({inbox_id: OTHER_INBOX, job_no: 'DGS-C00422'})], error: null})});
  const firstLoad = h.context.skydDraftLoad(INBOX, JOB);
  await h.context.skydDraftLoad(OTHER_INBOX, 'DGS-C00422');
  delayed.resolve({data: [run()], error: null});
  await firstLoad;
  assert.equal(h.state().inboxId, OTHER_INBOX);
  assert.equal(h.state().rows[0].job_no, 'DGS-C00422');
  assert.doesNotMatch(h.element('skyd_drafts_list').innerHTML, /AEXP-C00465/);
});

test('logout clears saved draft information and ignores a pending query or signed PDF result', async () => {
  const delayedQuery = deferred();
  const h = harness({query: () => delayedQuery.promise});
  const pending = h.context.skydDraftLoad(INBOX, JOB);
  h.context.sbUser = null;
  h.context.skydDraftReset();
  delayedQuery.resolve({data: [run()], error: null});
  await pending;
  assert.equal(h.state().rows.length, 0);
  assert.equal(h.element('skyd_drafts_list').innerHTML, '');
  assert.equal(h.element('skyd_drafts_status').textContent, '');

  const delayedSign = deferred();
  const h2 = harness({sign: () => delayedSign.promise});
  await h2.context.skydDraftLoad(INBOX, JOB);
  const pdf = h2.context.skydDraftPdf(RUN);
  h2.context.sbUser = null;
  h2.context.skydDraftReset();
  delayedSign.resolve({data: {signedUrl: `${ORIGIN}/storage/v1/object/sign/dgdocs/skyd-awb/${INBOX}/v1-${RUN}.pdf?token=synthetic`}, error: null});
  await pdf;
  assert.equal(h2.element(`skyd_draft_pdf_${RUN}`).innerHTML, '');
});

test('switching the authenticated account cannot publish a pending previous account result', async () => {
  const delayed = deferred();
  const h = harness({query: () => delayed.promise});
  const pending = h.context.skydDraftLoad(INBOX, JOB);
  h.context.sbUser = {id: 'different-staff-id'};
  delayed.resolve({data: [run()], error: null});
  await pending;
  assert.equal(h.element('skyd_drafts_list').innerHTML, '');
  assert.equal(h.state().rows.length, 0);
});

test('the inbox exposes read-only saved drafts and explains AWB preparation limits without changing manual SKYD', () => {
  assert.match(html, /onclick="skydDraftOpen\('\$\{r\.id\}'\)"/);
  assert.match(html, /SKYD PREPARE &lt;job no&gt; AWB/);
  assert.match(html, /6 original files, 3 pages per PDF, 4 sheets \/ 12,000 characters/);
  assert.match(html, /This command prepares an AWB draft; it does not prepare or approve a DGD/);
  assert.match(html, /onclick="skydRun\(\)"/);
  assert.match(html, /if\(typeof skydDraftReset === "function"\) skydDraftReset\(\)/);
  assert.doesNotMatch(source, /\.insert\(|\.upsert\(|\.update\(|\.delete\(|jobStart\(|applySnapshot\(|awbFill\(|setStore\(|autosaveCurrent\(/);
});
