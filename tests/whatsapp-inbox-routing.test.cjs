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

function harness({ currentJob = '', module = 'DG', files = [pdf('document.pdf')], message = 'DG DGS-C00465' } = {}) {
  const elements = new Map();
  const calls = { downloads: [], starts: [], tabs: [], readers: [], writes: [], alerts: [], confirms: [], conversions: [], pdfReads: [], packingApplications: [], saves: 0 };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', innerHTML: '', files: [], checked: false,
      style: {}, options: [], disabled: false, classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, removeAttribute() {},
    });
    return elements.get(id);
  };
  staleFields.forEach(id => { element(id).value = `previous-${id}`; });
  element('f_job').value = currentJob;
  ['awbfile', 'pt_file', 'gc_awbfile'].forEach(id => { element(id).files = [{ name: 'previous.pdf' }]; });
  const row = { id: 'inbox-1', job_no: 'DGS-C00465', sender: '971562977774', sender_name: 'Owner', status: 'NEW', message, note: 'Keep this note.', files };
  const context = {
    console, document: {
      getElementById: element,
      addEventListener() {},
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
      context.HAWBS = [];
      context.HOUSES = { list: [], ix: -1, labels: [] };
      if (value === 'GC') context.gcSyncFromMain();
    },
    showTab: value => { calls.tabs.push(value); if (value === 'gc') context.gcSyncFromMain(); },
    refresh() {}, autosaveCurrent() { calls.saves++; }, gcAirline() {}, hdRenderBar() {}, hbRender() {}, mfRender() {},
    gcSyncFromMain() {
      for (const [to, from] of Object.entries({ gc_awb: 'f_awb', gc_hawb: 'f_ref', gc_dep: 'f_dep', gc_dest: 'f_dest', gc_pcs: 'f_opcount', gc_goods: 'cs_goods', gc_shipper: 'f_shipper', gc_consignee: 'f_consignee' })) {
        if (element(from).value) element(to).value = element(from).value;
      }
      element('gc_job').value = element('f_job').value;
    },
    readAwbPdf: async (...args) => {
      calls.readers.push({ reader: 'awb', args, module: context.JOBTYPE });
      element(args[1] || 'awbpdfmsg').textContent = 'Done — fields filled. Check every field.';
    },
    ptReadPdf: async (...args) => {
      calls.readers.push({ reader: 'packing', args, module: context.JOBTYPE });
      element('pt_pdfmsg').textContent = 'Done — 2 pallets extracted. Check the table.';
    },
    ptReadMulti: async (...args) => {
      calls.readers.push({ reader: 'packing-multi', args, module: context.JOBTYPE });
      element('pt_pdfmsg').textContent = 'Done — packing lists extracted. Check the table.';
    },
    ptRowsFromFile: async file => {
      calls.readers.push({ reader: 'packing-parse', name: file.name, module: context.JOBTYPE });
      return { rows: [{ w: 20, l: 120, d: 80, h: 100, qty: 1 }], header: {} };
    },
    aiPalletRows: async (images, text) => {
      calls.readers.push({ reader: 'packing-text', text, module: context.JOBTYPE });
      return { rows: [{ w: 10, l: 120, d: 80, h: 100, qty: 1 }], header: {} };
    },
    _ptApply: (result, message) => {
      context.PT = Array.from(result.rows, row => ({ ...row }));
      calls.packingApplications.push(Array.from(result.rows, row => row.w));
      message.textContent = `Done — ${result.rows.length} pallet rows extracted. Check the table.`;
      return result.rows.length > 0;
    },
    ptHeaderFill() {}, plSet() {}, ptRender() {}, prompt: () => '',
    hdReadMulti: async (...args) => {
      calls.readers.push({ reader: 'house', args, module: context.JOBTYPE });
      element(args[1] || 'awbpdfmsg').textContent = 'Done — shipment documents read. Check every field.';
    },
    aiAutoFill: async () => {
      calls.readers.push({ reader: 'shipment-text', text: element('f_auto').value, module: context.JOBTYPE });
      element('autoresult').textContent = 'AI extracted: AWB, pieces — please check every field.';
    },
    aiExtractShipment: async (text, label, images) => {
      calls.readers.push({ reader: /\bPDF\b/.test(label) ? 'shipment-pdf' : 'shipment-image', text, label, images, module: context.JOBTYPE });
      return { awb: '176-12345678' };
    },
    hdPdfRead: async file => {
      calls.pdfReads.push(file.name);
      return { text: `Shipper: Example Trading LLC\nAWB: 176-12345678\n3 pieces, 45 kg\nSource: ${file.name}`, imgs: [] };
    },
    filesToImgs: async input => input.map(file => `synthetic-image:${file.name}`),
    fileToJpeg: async file => `synthetic-image:${file.name}`,
    imgFileToB64: async file => `synthetic-image:${file.name}`,
    loadSheetJs: async () => {},
    XLSX: {
      read: input => {
        calls.conversions.push({ format: 'EXCEL', input });
        return { SheetNames: ['Shipment'], Sheets: { Shipment: { rows: 'AWB 176-12345678\n3 pieces, 45 kg' } } };
      },
      utils: { sheet_to_csv: sheet => sheet.rows, sheet_to_json: sheet => [[sheet.rows]] },
    },
    mockedDownload: async file => {
      calls.downloads.push(file);
      return {
        name: file.name, type: file.mime, bytes: 'synthetic',
        text: async () => file.text || 'AWB 176-12345678\n3 pieces, 45 kg',
        arrayBuffer: async () => Buffer.from('synthetic workbook').buffer,
      };
    },
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
    state: code => JSON.parse(JSON.stringify(vm.runInContext(code, context))),
    select(code) { context.selectedCode = code; vm.runInContext('WAI.types["inbox-1"] = selectedCode;', context); },
    async open() { await vm.runInContext('waiOpen("inbox-1")', context); },
  };
}

function pdf(name) { return { path: `wa-inbox/inbox-1/${name}`, name, mime: 'application/pdf', size: 100 }; }
function documentFile(name, mime, text) { return { path: `wa-inbox/inbox-1/${name}`, name, mime, size: 100, ...(text ? { text } : {}) }; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

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

test('DGS opening attaches documents without extraction; explicit read retains DG AWB and packing routes', async () => {
  const h = harness({ files: [pdf('mawb.pdf'), pdf('packing-list.pdf')] });
  h.select('DGS');
  await h.open();
  assert.equal(h.context.JOBTYPE, 'DG');
  assert.equal(h.calls.tabs.at(-1), 'dgd');
  assert.equal(h.calls.readers.length, 0, 'Opening must not start extraction automatically');
  assert.equal(h.evaluate('WAI.documents.length'), 2);
  h.evaluate('waiChooseDocumentRole(0, "AWB")');
  await h.evaluate('waiReadSelected(true)');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['awb', 'packing-parse']);
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

test('explicit read processes exactly the chosen PDF through the GC reader', async () => {
  const h = harness({ files: [pdf('invoice.pdf'), pdf('packing-list.pdf')] });
  h.select('AEXP');
  await h.open();
  await h.evaluate('waiReadDocument(1)');
  assert.deepEqual(h.calls.pdfReads, ['packing-list.pdf']);
  assert.equal(h.calls.readers.length, 1);
  assert.equal(h.calls.readers[0].reader, 'shipment-pdf');
  assert.equal(h.calls.readers[0].module, 'GC');
  assert.match(h.calls.readers[0].label, /packing-list\.pdf/);
});

test('stale document buttons cannot inject a previous PDF into a different job or module', async () => {
  for (const change of ['different-job', 'DG-module']) {
    const h = harness();
    h.select('AEXP');
    await h.open();
    if (change === 'different-job') h.element('f_job').value = 'GEN-C00888';
    else h.context.JOBTYPE = 'DG';
    await h.evaluate('waiReadDocument(0)');
    assert.equal(h.calls.readers.length, 0);
    assert.match(h.calls.alerts.at(-1), /open.*inbox job again/i);
  }
});

test('routing command lines are excluded from substantive shipment text without discarding customer prose', () => {
  const h = harness();
  h.row.message = 'DG DGS-C00465\r\n\r\n dg DGS-C00465 \n';
  assert.equal(h.evaluate('waiMessageText(WAI.rows[0])'), '');
  h.row.message = 'DG DGS-C00465\nShipper: Example Trading LLC\n3 cartons, 45 kg\nPlease process DG DGS-C00465 today.';
  assert.equal(h.evaluate('waiMessageText(WAI.rows[0])'), 'Shipper: Example Trading LLC\n3 cartons, 45 kg\nPlease process DG DGS-C00465 today.');
});

test('command-only jobs without documents cannot open, reset fields or claim to be loaded', async () => {
  const h = harness({ currentJob: 'GEN-C00999', module: 'GC', files: [], message: 'DG DGS-C00465' });
  h.select('AEXP');
  await h.open();
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.starts.length, 0);
  assert.equal(h.calls.readers.length, 0);
  assert.equal(h.element('f_job').value, 'GEN-C00999');
  assert.equal(h.element('gc_wt').value, 'previous-gc_wt');
  assert.equal(h.calls.alerts.length, 1);
});

test('a substantive text-only job opens and is read only after the explicit message action', async () => {
  const shipment = 'Shipper: Example Trading LLC\nConsignee: Example Buyer\nAWB: 176-12345678\n3 pieces; 45 kg';
  const h = harness({ files: [], message: `DG DGS-C00465\n${shipment}` });
  h.select('AEXP');
  await h.open();
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.context.JOBTYPE, 'GC');
  assert.equal(h.evaluate('WAI.documents.length'), 0);
  assert.equal(h.evaluate('WAI.text'), shipment);
  assert.equal(h.calls.readers.length, 0);
  await h.evaluate('waiReadMessage()');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['shipment-text']);
  assert.equal(h.calls.readers[0].text, shipment);
  assert.equal(h.calls.readers[0].module, 'GC');
  assert.equal(h.element('gc_auto').value, shipment);
});

test('opening DG documents without an AI key still attaches them and does not attempt extraction', async () => {
  const h = harness({ files: [pdf('mawb.pdf'), pdf('packing-list.pdf')] });
  h.context.aiKey = () => '';
  h.select('DGS');
  await h.open();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.evaluate('WAI.documents.length'), 2);
  assert.equal(h.calls.readers.length, 0);
  assert.equal(h.calls.alerts.length, 0);
});

test('PDF, Excel, JPG, PNG and text attachments are all retained separately and in order', async () => {
  const files = [
    pdf('mawb.pdf'),
    documentFile('invoice.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    documentFile('label.jpg', 'image/jpeg'),
    documentFile('booking.png', 'image/png'),
    documentFile('shipment.txt', 'text/plain', 'Shipper: Example\n4 cartons, 80 kg'),
  ];
  const h = harness({ files });
  h.select('AEXP');
  await h.open();
  assert.deepEqual(h.calls.downloads.map(f => f.path), files.map(f => f.path));
  assert.deepEqual(h.state('WAI.documents.map(d => d.file.name)'), files.map(f => f.name));
  assert.deepEqual(h.state('WAI.documents.map(d => d.format)'), ['PDF', 'EXCEL', 'IMAGE', 'IMAGE', 'TEXT']);
  assert.deepEqual(h.state('WAI.documents.map(d => d.source.path)'), files.map(f => f.path));
  assert.equal(h.evaluate('WAI.documents.every(d => d.selected)'), true);
  assert.equal(h.calls.readers.length, 0);
});

test('document role is independent of format and can be corrected before reading', async () => {
  const h = harness({ files: [
    documentFile('packing-list.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    pdf('packing-list.pdf'),
    documentFile('label.png', 'image/png'),
  ] });
  h.select('DGS');
  await h.open();
  assert.deepEqual(h.state('WAI.documents.map(d => d.role)'), ['PACKING', 'PACKING', 'LABEL']);
  h.evaluate('waiChooseDocumentRole(0, "SHIPMENT")');
  h.evaluate('waiChooseDocumentRole(1, "SHIPMENT")');
  h.evaluate('waiChooseDocumentRole(2, "SHIPMENT")');
  assert.deepEqual(h.state('WAI.documents.map(d => d.role)'), ['SHIPMENT', 'SHIPMENT', 'SHIPMENT']);
  assert.deepEqual(h.state('WAI.documents.map(d => d.format)'), ['EXCEL', 'PDF', 'IMAGE']);
  h.evaluate('waiChooseDocumentRole(0, "PACKING")');
  await h.evaluate('waiReadDocument(0)');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['packing-parse']);
  assert.equal(h.calls.readers[0].name, 'packing-list.xlsx');
});

test('selected reading omits unchecked files while read all includes them without losing the loaded list', async () => {
  const h = harness({ files: [pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf')] });
  h.select('AEXP');
  await h.open();
  h.evaluate('WAI.documents.forEach((d,i) => waiChooseDocumentRole(i, "AWB"))');
  h.evaluate('waiChooseDocument(1, false)');
  const readNames = [];
  h.context.readAwbPdf = async (fileId, msgId) => {
    readNames.push(h.element(fileId).files[0].name);
    h.element(msgId).textContent = 'Done — fields filled. Check every field.';
  };
  await h.evaluate('waiReadSelected()');
  assert.deepEqual(readNames, ['one.pdf', 'three.pdf']);
  assert.deepEqual(h.state('WAI.documents.map(d => d.selected)'), [true, false, true]);
  await h.evaluate('waiReadSelected(true)');
  assert.deepEqual(readNames, ['one.pdf', 'three.pdf', 'one.pdf', 'two.pdf', 'three.pdf']);
  assert.deepEqual(h.state('WAI.documents.map(d => d.file.name)'), ['one.pdf', 'two.pdf', 'three.pdf']);
});

test('read all awaits each GC document and ignores overlapping read or open clicks', async () => {
  const h = harness({ files: [pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf')] });
  h.select('AEXP');
  await h.open();
  h.evaluate('WAI.documents.forEach((d,i) => waiChooseDocumentRole(i, "AWB"))');
  const releases = [deferred(), deferred(), deferred()];
  const events = [];
  h.context.readAwbPdf = async (fileId, msgId) => {
    const index = events.filter(e => e.startsWith('start:')).length;
    const name = h.element(fileId).files[0].name;
    events.push(`start:${name}`);
    await releases[index].promise;
    events.push(`finish:${name}`);
    h.element(msgId).textContent = 'Done — fields filled. Check every field.';
  };
  const running = h.evaluate('waiReadSelected(true)');
  await Promise.resolve();
  assert.deepEqual(events, ['start:one.pdf']);
  assert.equal(h.evaluate('WAI.busy'), true);
  assert.equal(h.evaluate('WAI.extracting'), true);
  assert.equal(h.element('wai_readinglock').style.display, 'flex');
  h.evaluate('waiChooseDocument(1, false); waiChooseDocumentRole(1, "PACKING")');
  assert.equal(h.evaluate('WAI.documents[1].selected'), true, 'Document selection cannot change during a read');
  assert.equal(h.evaluate('WAI.documents[1].role'), 'AWB', 'Document role cannot change during a read');
  await h.evaluate('waiReadDocument(2)');
  await h.evaluate('waiReadSelected(true)');
  await h.open();
  assert.deepEqual(events, ['start:one.pdf']);
  assert.equal(h.calls.writes.length, 1, 'An overlapping open must not restart the job');
  releases[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:one.pdf', 'finish:one.pdf', 'start:two.pdf']);
  releases[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:one.pdf', 'finish:one.pdf', 'start:two.pdf', 'finish:two.pdf', 'start:three.pdf']);
  releases[2].resolve();
  await running;
  assert.equal(h.evaluate('WAI.busy'), false);
  assert.equal(h.evaluate('WAI.extracting'), false);
  assert.equal(h.element('wai_readinglock').style.display, 'none');
  assert.deepEqual(events.at(-1), 'finish:three.pdf');
});

test('General Cargo Excel and image files use neutral shipment extraction without DG packing or house readers', async () => {
  const h = harness({ files: [
    documentFile('packing-list.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    documentFile('label.jpg', 'image/jpeg'),
    documentFile('invoice.png', 'image/png'),
  ] });
  h.select('AEXP');
  await h.open();
  await h.evaluate('waiReadSelected(true)');
  assert.equal(h.calls.conversions.length, 1);
  assert.equal(h.calls.readers.filter(r => r.reader === 'shipment-text').length, 1);
  assert.equal(h.calls.readers.filter(r => r.reader === 'shipment-image').length, 2);
  assert.equal(h.calls.readers.some(r => ['packing', 'packing-multi', 'packing-parse', 'packing-text', 'house'].includes(r.reader)), false);
  assert.equal(h.calls.readers.every(r => r.module === 'GC'), true);
});

test('DG reading batches shipment and packing documents separately and waits between the two readers', async () => {
  const h = harness({ files: [pdf('master-awb.pdf'), pdf('house-awb.pdf'), pdf('packing-one.pdf'), pdf('packing-two.pdf')] });
  h.select('DGS');
  await h.open();
  h.evaluate('waiChooseDocumentRole(0, "AWB"); waiChooseDocumentRole(1, "AWB")');
  const first = deferred();
  const batches = [];
  h.context.hdReadMulti = async (files, msgId) => {
    batches.push({ reader: 'house', names: Array.from(files, f => f.name) });
    await first.promise;
    h.element(msgId || 'awbpdfmsg').textContent = 'Done — both AWBs read. Check every field.';
  };
  h.context.ptRowsFromFile = async file => {
    batches.push({ reader: 'packing', names: [file.name] });
    return { rows: [{ w: 20, l: 120, d: 80, h: 100, qty: 1 }], header: {} };
  };
  const running = h.evaluate('waiReadSelected(true)');
  await Promise.resolve();
  assert.deepEqual(batches, [{ reader: 'house', names: ['master-awb.pdf', 'house-awb.pdf'] }]);
  assert.equal(h.evaluate('WAI.busy'), true);
  first.resolve();
  await running;
  assert.deepEqual(batches, [
    { reader: 'house', names: ['master-awb.pdf', 'house-awb.pdf'] },
    { reader: 'packing', names: ['packing-one.pdf'] },
    { reader: 'packing', names: ['packing-two.pdf'] },
  ]);
  assert.equal(h.evaluate('WAI.busy'), false);
  assert.equal(h.evaluate('WAI.documents.length'), 4);
});

test('plain-text attachments use their own text and never enter PDF, packing or house readers in GC', async () => {
  const text = 'Shipper: Text File Ltd\n4 cartons, 80 kg';
  const h = harness({ files: [documentFile('shipment.txt', 'text/plain', text)] });
  h.select('AEXP');
  await h.open();
  await h.evaluate('waiReadDocument(0)');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['shipment-text']);
  assert.equal(h.calls.readers[0].text, text);
  assert.equal(h.calls.readers[0].module, 'GC');
});

test('DG shipment and invoice PDFs do not enter the multiple house-AWB reader', async () => {
  const h = harness({ files: [pdf('commercial-invoice.pdf'), pdf('booking-details.pdf')] });
  h.select('DGS');
  await h.open();
  h.evaluate('waiChooseDocumentRole(0, "SHIPMENT"); waiChooseDocumentRole(1, "SHIPMENT")');
  await h.evaluate('waiReadSelected(true)');
  assert.deepEqual(h.calls.readers.map(r => r.reader), ['shipment-pdf', 'shipment-pdf']);
  assert.deepEqual(h.calls.readers.map(r => r.module), ['DG', 'DG']);
  assert.equal(h.calls.readers.some(r => r.reader === 'house'), false);
});

test('multiple DG AWBs needing AI are reported as a warning instead of successful extraction', async () => {
  const h = harness({ files: [pdf('master-awb.pdf'), pdf('house-awb.pdf')] });
  h.context.aiKey = () => '';
  h.select('DGS');
  await h.open();
  h.evaluate('waiChooseDocumentRole(0, "AWB"); waiChooseDocumentRole(1, "AWB")');
  h.context.hdReadMulti = async () => { h.element('awbpdfmsg').textContent = 'Multiple AWBs need the AI — add a Claude API key in Settings.'; };
  await h.evaluate('waiReadSelected(true)');
  assert.match(h.evaluate('WAI.status'), /read warning/i);
  assert.match(h.evaluate('WAI.status'), /need the AI/i);
  assert.equal(h.evaluate('WAI.busy'), false);
});

test('DG mixed packing messages, TXT, PDF and Excel inputs retain every extracted pallet row', async () => {
  const h = harness({
    message: 'DG DGS-C00465\nPacking message: pallet MESSAGE, 10 kg',
    files: [
      documentFile('packing-text.txt', 'text/plain', 'Packing attachment: pallet TEXT, 20 kg'),
      pdf('packing-pdf.pdf'),
      documentFile('packing-excel.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ],
  });
  h.select('DGS');
  await h.open();
  h.evaluate('WAI.messageRole = "PACKING"; WAI.documents.forEach((d,i) => waiChooseDocumentRole(i, "PACKING"))');
  const weightFor = name => name.endsWith('.pdf') ? 30 : name.endsWith('.xlsx') ? 40 : 20;
  const result = weight => ({ rows: [{ w: weight, l: 120, d: 80, h: 100, qty: 1 }], header: {} });
  h.context.aiPalletRows = async (images, text) => result(String(text).includes('MESSAGE') ? 10 : 20);
  h.context.ptRowsFromFile = async file => result(weightFor(file.name));
  h.context._ptApply = (res, message) => {
    h.context.PT = Array.from(res.rows, row => ({ ...row }));
    message.textContent = `Done — ${res.rows.length} pallet rows extracted.`;
    return true;
  };
  // Model the existing legacy readers' replacement behavior; the inbox flow must merge it safely.
  h.context.ptReadPdf = async () => {
    const file = h.element('pt_file').files[0];
    h.context.PT = result(weightFor(file.name)).rows;
    h.element('pt_pdfmsg').textContent = 'Done — pallet rows extracted.';
  };
  h.context.ptReadMulti = async files => {
    h.context.PT = Array.from(files, file => result(weightFor(file.name)).rows[0]);
    h.element('pt_pdfmsg').textContent = `Done — ${files.length} packing lists extracted.`;
  };
  await h.evaluate('waiReadSelected(true)');
  assert.deepEqual(Array.from(h.context.PT, row => row.w).sort((a,b) => a - b), [10, 20, 30, 40]);
  assert.equal(h.evaluate('WAI.documents.length'), 3);
  assert.equal(h.evaluate('WAI.text.includes("MESSAGE")'), true);
  assert.equal(h.evaluate('WAI.documents.every(d => d.result)'), true);
  assert.equal(h.evaluate('WAI.busy'), false);
  await h.evaluate('waiReadDocument(0)');
  assert.deepEqual(Array.from(h.context.PT, row => row.w).sort((a,b) => a - b), [10, 20, 30, 40], 'Rereading a source must replace its rows instead of duplicating them');
});

test('individual PDF extraction failures are reported without a false success and release the busy guard', async () => {
  const h = harness();
  h.select('AEXP');
  await h.open();
  h.evaluate('waiChooseDocumentRole(0, "AWB")');
  h.context.readAwbPdf = async () => { throw new Error('synthetic PDF extraction failure'); };
  await h.evaluate('waiReadDocument(0)');
  const visible = ['wai_msg', 'gc_pdfmsg', 'gc_inbox_files', 'wai_documents'].map(id => h.element(id).textContent + h.element(id).innerHTML).join('\n');
  assert.match(visible, /synthetic PDF extraction failure/);
  assert.equal(h.evaluate('WAI.busy'), false);
});

test('a legacy reader that catches its own error does not make the inbox claim extraction succeeded', async () => {
  const h = harness();
  h.select('AEXP');
  await h.open();
  h.evaluate('waiChooseDocumentRole(0, "AWB")');
  h.context.readAwbPdf = async (fileId, msgId) => { h.element(msgId).textContent = 'Failed: synthetic unreadable PDF'; };
  await h.evaluate('waiReadDocument(0)');
  const visible = ['wai_msg', 'gc_pdfmsg', 'gc_inbox_files', 'wai_documents'].map(id => h.element(id).textContent + h.element(id).innerHTML).join('\n');
  assert.match(visible, /synthetic unreadable PDF/);
  assert.doesNotMatch(h.element('wai_msg').textContent, /all.*(?:success|extracted)|successfully read/i);
  assert.equal(h.evaluate('WAI.busy'), false);
});

test('conflicting later shipment documents retain their inputs and warn which fields changed', async () => {
  const h = harness({ files: [
    documentFile('first-shipment.txt', 'text/plain', 'FIRST: AWB 176-12345678, Shipper First Trading LLC'),
    documentFile('second-shipment.txt', 'text/plain', 'SECOND: AWB 176-87654321, Shipper Second Trading LLC'),
  ] });
  h.select('AEXP');
  await h.open();
  const texts = [];
  h.context.aiAutoFill = async () => {
    const text = h.element('f_auto').value;
    texts.push(text);
    const first = text.startsWith('FIRST:');
    h.element('f_awb').value = first ? '176-12345678' : '176-87654321';
    h.element('f_shipper').value = first ? 'First Trading LLC' : 'Second Trading LLC';
    h.element('autoresult').textContent = 'AI extracted: AWB, shipper — please check every field.';
  };
  await h.evaluate('waiReadSelected(true)');
  assert.deepEqual(texts, h.row.files.map(f => f.text));
  assert.equal(h.element('gc_awb').value, '176-87654321');
  assert.equal(h.element('gc_shipper').value, 'Second Trading LLC');
  assert.match(h.evaluate('WAI.status'), /Fields changed by later documents:/);
  assert.match(h.evaluate('WAI.status'), /awb/);
  assert.match(h.evaluate('WAI.status'), /shipper/);
  assert.match(h.evaluate('WAI.status'), /Still missing:/);
  assert.deepEqual(h.state('WAI.documents.map(d => d.file.name)'), ['first-shipment.txt', 'second-shipment.txt']);
});

test('a new text-only job discards old attachment controls and stale extraction data', async () => {
  const h = harness({ files: [pdf('previous-inbox.pdf')] });
  h.select('AEXP');
  await h.open();
  h.element('gc_wt').value = '777';
  h.element('gc_auto').value = 'Previous cargo details';
  h.row.job_no = 'GEN-C00777';
  h.row.files = [];
  h.row.message = 'DG GEN-C00777\nNew shipper: Example Company\n2 cartons, 10 kg';
  await h.open();
  assert.equal(h.evaluate('WAI.documents.length'), 0);
  assert.equal(h.evaluate('WAI.text'), 'New shipper: Example Company\n2 cartons, 10 kg');
  assert.equal(h.element('gc_wt').value, '');
  assert.equal(h.element('gc_auto').value, 'New shipper: Example Company\n2 cartons, 10 kg');
  assert.equal(h.element('gc_awbfile').value, '');
  assert.equal(h.evaluate('WAI.gcFiles.length'), 0);
  assert.equal(h.calls.readers.length, 0);
});

