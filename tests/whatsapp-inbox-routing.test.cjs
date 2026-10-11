'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(source, start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `Missing source boundary: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `Missing source boundary: ${end}`);
  return source.slice(first, last);
}

const codesSource = between(html, 'const JFS_JOB_TYPES = {', '\nfunction jobTypeOptions');
const inboxSource = between(html, 'let WAI = ', '/* allowed DG staff WhatsApp numbers');

const staleFields = [
  'gc_awb', 'gc_hawb', 'gc_dep', 'gc_dest', 'gc_pcs', 'gc_wt', 'gc_goods',
  'gc_shipper', 'gc_consignee', 'gc_auto', 'cs_goods', 'f_auto',
  'aw_no', 'aw_flight', 'aw_to1', 'aw_by1', 'aw_chwt', 'aw_rate', 'aw_dims', 'aw_handl',
];

function harness({ currentJob = '', module = 'DG', files = [pdf('document.pdf')] } = {}) {
  const elements = new Map();
  const calls = { downloads: [], starts: [], tabs: [], readers: [], writes: [], alerts: [], confirms: [] };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', innerHTML: '', files: [], checked: false,
      style: {}, options: [], classList: { contains: () => false },
      addEventListener() {}, setAttribute() {}, removeAttribute() {},
    });
    return elements.get(id);
  };
  staleFields.forEach(id => { element(id).value = `previous-${id}`; });
  element('f_job').value = currentJob;
  ['awbfile', 'pt_file', 'gc_awbfile'].forEach(id => { element(id).files = [{ name: 'previous.pdf' }]; });
  const row = { id: 'inbox-1', job_no: 'DGS-C00465', sender: '971562977774', sender_name: 'Owner', status: 'NEW', message: 'DG DGS-C00465', note: 'Keep this note.', files };
  const context = {
    console, document: {
      getElementById: element,
      querySelector: () => ({ checked: false }),
      querySelectorAll: selector => [...elements.values()].filter(e => selector.includes('gc') ? e.id.startsWith('gc_') : selector.includes('aw') ? e.id.startsWith('aw_') : false),
    },
    DataTransfer: class {
      constructor() { this.files = []; this.items = { add: f => { this.files.push(f); } }; }
    },
    JOBTYPE: module, _acceptRow: { id: 'unrelated-warehouse-row' }, _afterStartTab: 'dgd',
    PT: [{ w: 999 }], HAWBS: [{ no: 'OLD-HOUSE' }], HOUSES: { list: [{}], ix: 0, labels: [{}] },
    sbUser: { email: 'owner@example.test' },
    sb: { from(table) { return { update(payload) { return { async eq(key, id) { calls.writes.push({ table, payload, key, id }); return { error: null }; } }; } }; } },
    v: id => element(id).value,
    aiKey: () => 'synthetic-ai-key',
    esc: text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    alert: message => calls.alerts.push(message),
    confirm: message => { calls.confirms.push(message); return true; },
    setJobType: value => { context.JOBTYPE = value; },
    jobStart: value => {
      calls.starts.push({ module: value, acceptRow: context._acceptRow, afterStartTab: context._afterStartTab });
      context.JOBTYPE = value;
      element('f_job').value = element('jg_job').value;
      ['f_awb', 'f_ref', 'f_shipper', 'f_consignee', 'f_dep', 'f_dest'].forEach(id => { element(id).value = ''; });
      // Real jobStart applies DG saved defaults and then opens GC, whose sync copies them.
      element('f_shipper').value = 'Saved DG shipper default';
      element('f_opcount').value = '1';
      context.PT = [];
      if (value === 'GC') context.gcSyncFromMain();
    },
    showTab: value => { calls.tabs.push(value); if (value === 'gc') context.gcSyncFromMain(); },
    refresh() {}, autosaveCurrent() {}, gcAirline() {}, hdRenderBar() {}, hbRender() {}, mfRender() {},
    gcSyncFromMain() {
      for (const [to, from] of Object.entries({ gc_awb: 'f_awb', gc_hawb: 'f_ref', gc_dep: 'f_dep', gc_dest: 'f_dest', gc_pcs: 'f_opcount', gc_goods: 'cs_goods', gc_shipper: 'f_shipper', gc_consignee: 'f_consignee' })) {
        if (element(from).value) element(to).value = element(from).value;
      }
      element('gc_job').value = element('f_job').value;
    },
    readAwbPdf: async (...args) => calls.readers.push({ reader: 'awb', args, module: context.JOBTYPE }),
    ptReadPdf: async (...args) => calls.readers.push({ reader: 'packing', args, module: context.JOBTYPE }),
    hdReadMulti: async (...args) => calls.readers.push({ reader: 'house', args, module: context.JOBTYPE }),
    mockedDownload: async file => { calls.downloads.push(file); return { name: file.name, type: file.mime, bytes: 'synthetic' }; },
    mockedLoad: async () => {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${codesSource}\n${inboxSource}\nwaiFile = mockedDownload; waiLoad = mockedLoad;`, context);
  context.fixtureRows = [row];
  vm.runInContext('WAI.rows = fixtureRows; WAI.types = WAI.types || {};', context);
  return {
    context, row, calls, element,
    evaluate: code => vm.runInContext(code, context),
    select(code) { context.selectedCode = code; vm.runInContext('WAI.types["inbox-1"] = selectedCode;', context); },
    async open() { await vm.runInContext('waiOpen("inbox-1")', context); },
  };
}

function pdf(name) { return { path: `wa-inbox/inbox-1/${name}`, name, mime: 'application/pdf', size: 100 }; }

test('DGS, ELI and ELM open DG Shipment; general service codes open General Cargo', () => {
  const h = harness();
  for (const code of ['DGS', 'ELI', 'ELM']) assert.equal(h.evaluate(`waiDestination('${code}')`), 'DG');
  for (const code of ['AEXP', 'AIMP', 'ACCL', 'CRT', 'GEN', 'SELC', 'WH']) assert.equal(h.evaluate(`waiDestination('${code}')`), 'GC');
  for (const code of ['', 'TEST', 'UNKNOWN', 'constructor', '__proto__']) assert.equal(h.evaluate(`waiDestination('${code}')`), null);
});

test('explicit selected type overrides row metadata, persisted note and a conflicting job-number prefix', () => {
  const h = harness();
  h.row.job_type = 'GEN';
  h.row.note = 'Job type: AIMP';
  h.select('AEXP');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'AEXP');
  h.evaluate('delete WAI.types["inbox-1"]');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'GEN');
  h.row.job_type = 'invalid';
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'AIMP');
  h.row.note = '';
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), 'DGS');
});

test('clearing the visible selector blocks reopening instead of restoring a prefix-derived default', () => {
  const h = harness();
  h.evaluate('waiChooseType("inbox-1", "")');
  assert.equal(h.evaluate('waiJobType(WAI.rows[0])'), '');
});

test('type-note parser uses the latest valid anchored field and ignores prose and unsupported values', () => {
  const h = harness();
  h.context.testNote = 'Job type: DGS\nCustomer said Job type: CRT yesterday\nJob type: AEXP\nJob type: TEST';
  assert.equal(h.evaluate('waiNoteType(testNote)'), 'AEXP');
  h.context.testNote = 'Quoted Job type: DGS\nJob type: AEXP extra words\nJob type: TEST';
  assert.equal(h.evaluate('waiNoteType(testNote)'), '');
});

test('saving a type replaces the old anchored field while preserving unrelated notes', () => {
  const h = harness();
  h.context.testNote = 'Keep shipper unchanged.\r\nJob type: DGS\r\nCustomer said Job type: CRT yesterday\r\n\r\n';
  assert.equal(h.evaluate('waiTypeNote(testNote, "AEXP")'), 'Keep shipper unchanged.\nCustomer said Job type: CRT yesterday\nJob type: AEXP');
  assert.throws(() => h.evaluate('waiTypeNote(testNote, "TEST")'), /listed job type/);
});

test('legacy TEST job is blocked before download, write, extraction or form reset', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC' });
  h.row.job_no = 'TEST-C00001';
  await h.open();
  assert.equal(h.calls.alerts.length, 1);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.calls.readers.length, 0);
  assert.equal(h.element('f_job').value, 'GEN-C00999');
  assert.equal(h.element('gc_wt').value, 'previous-gc_wt');
});

test('DGS route retains DG AWB and packing readers and clears unrelated warehouse state', async () => {
  const h = harness({ files: [pdf('mawb.pdf'), pdf('packing-list.pdf')] });
  h.select('DGS');
  await h.open();
  assert.equal(h.context.JOBTYPE, 'DG');
  assert.equal(h.calls.tabs.at(-1), 'dgd');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['awb', 'packing']);
  assert.deepEqual(h.calls.starts, [{ module: 'DG', acceptRow: null, afterStartTab: null }]);
  assert.equal(h.element('job_type_dg').value, 'DGS');
  assert.equal(h.calls.writes[0].payload.status, 'OPENED');
});

test('manual AEXP selection routes a DGS-prefixed job to General Cargo and keeps every PDF available without automatic AI', async () => {
  const h = harness({ files: [pdf('invoice.pdf'), pdf('packing-list.pdf')] });
  h.context.aiKey = () => '';
  h.select('AEXP');
  await h.open();
  assert.equal(h.context.JOBTYPE, 'GC');
  assert.equal(h.calls.tabs.at(-1), 'gc');
  assert.equal(h.element('job_type_gc').value, 'AEXP');
  assert.equal(h.element('f_job').value, 'DGS-C00465');
  assert.deepEqual(h.element('gc_awbfile').files.map(f => f.name), ['invoice.pdf', 'packing-list.pdf']);
  assert.equal(h.evaluate('WAI.gcFiles.length'), 2);
  assert.equal(h.evaluate('WAI.gcJob'), 'DGS-C00465');
  assert.equal(h.calls.readers.length, 0);
  assert.equal(h.calls.alerts.length, 0);
  assert.match(h.calls.writes[0].payload.note, /^Keep this note\.\nJob type: AEXP$/);
});

test('same job number switching DG to General Cargo starts a fresh form', async () => {
  const h = harness({ currentJob: 'DGS-C00465', module: 'DG' });
  h.select('AEXP');
  await h.open();
  assert.equal(h.calls.confirms.length, 1);
  assert.equal(h.calls.starts.length, 1);
  assert.equal(h.calls.starts[0].module, 'GC');
  assert.equal(h.element('f_job').value, 'DGS-C00465');
  assert.equal(h.calls.tabs.at(-1), 'gc');
});

test('same job and destination retains entered shipment fields instead of resetting them', async () => {
  const h = harness({ currentJob: 'DGS-C00465', module: 'GC' });
  h.select('AEXP');
  await h.open();
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.calls.confirms.length, 0);
  assert.equal(h.element('gc_wt').value, 'previous-gc_wt');
});

test('fresh General Cargo inbox job clears previous weight, goods, AWB number and charges', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC' });
  h.select('AEXP');
  await h.open();
  for (const id of staleFields) assert.equal(h.element(id).value, '', `Previous shipment value survived in ${id}`);
  assert.equal(h.element('aw_pc').value, 'PREPAID');
  for (const id of ['f_shipper', 'f_opcount', 'gc_shipper', 'gc_pcs']) {
    assert.equal(h.element(id).value, '', `DG saved defaults must not become GC shipment evidence in ${id}`);
  }
  assert.equal(h.calls.starts[0].acceptRow, null);
  assert.equal(h.calls.starts[0].afterStartTab, null);
});

test('canceling a fresh job switch leaves the current job, inbox and pending warehouse selection untouched', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC' });
  h.select('DGS');
  h.context.confirm = message => { h.calls.confirms.push(message); return false; };
  await h.open();
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.element('f_job').value, 'GEN-C00999');
  assert.equal(h.context._acceptRow.id, 'unrelated-warehouse-row');
});

test('one failed download aborts the whole load before changing current form or marking OPENED', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC', files: [pdf('good.pdf'), pdf('missing.pdf')] });
  h.select('AEXP');
  h.context.mockedDownload = async f => { h.calls.downloads.push(f); if (f.name === 'missing.pdf') throw new Error('synthetic failure'); return { name: f.name, type: f.mime }; };
  h.evaluate('waiFile = mockedDownload');
  await h.open();
  assert.equal(h.calls.downloads.length, 2);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.calls.readers.length, 0);
  assert.equal(h.element('f_job').value, 'GEN-C00999');
  assert.equal(h.element('aw_rate').value, 'previous-aw_rate');
  assert.equal(h.evaluate('WAI.busy'), false);
  assert.match(h.element('wai_msg').textContent, /current job was not changed/i);
});

test('failed inbox persistence leaves the current form untouched', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC' });
  h.select('AEXP');
  h.context.sb.from = () => ({ update() { return { async eq() { return { error: { message: 'synthetic write failure' } }; } }; } });
  await h.open();
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.element('f_job').value, 'GEN-C00999');
  assert.equal(h.element('gc_wt').value, 'previous-gc_wt');
  assert.match(h.calls.alerts[0], /synthetic write failure/);
});

test('explicit Read this PDF processes exactly the chosen file through the GC reader', async () => {
  const h = harness({ files: [pdf('invoice.pdf'), pdf('packing-list.pdf')] });
  h.select('AEXP');
  await h.open();
  await h.evaluate('waiReadGcFile(1)');
  assert.deepEqual(h.element('gc_awbfile').files.map(f => f.name), ['packing-list.pdf']);
  assert.equal(h.calls.readers.length, 1);
  assert.deepEqual(h.calls.readers[0], { reader: 'awb', args: ['gc_awbfile', 'gc_pdfmsg'], module: 'GC' });
});

test('stale GC file buttons cannot inject a previous PDF into a different job or DG module', async () => {
  for (const change of ['different-job', 'DG-module']) {
    const h = harness();
    h.select('AEXP');
    await h.open();
    if (change === 'different-job') h.element('f_job').value = 'GEN-C00888';
    else h.context.JOBTYPE = 'DG';
    await h.evaluate('waiReadGcFile(0)');
    assert.equal(h.calls.readers.length, 0);
    assert.match(h.calls.alerts.at(-1), /open this General Cargo inbox job again/i);
  }
});

