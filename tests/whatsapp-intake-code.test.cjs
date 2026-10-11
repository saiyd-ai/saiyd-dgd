'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test'), assert = require('node:assert/strict');
const fixtures = require('./helpers/whatsapp-media-fixtures.cjs');
const parseCode = fs.readFileSync(path.join(__dirname, '../n8n/parse-owner-message.code.js'), 'utf8');
const fileCode = fs.readFileSync(path.join(__dirname, '../n8n/add-owner-file.code.js'), 'utf8');
const OWNER = '971562977774', WABA = '2911407919205442', PHONE = '1388023121061452';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLS = 'application/vnd.ms-excel';
const msg = (id, extra = {}) => ({ id, from: OWNER, timestamp: '1791691200', type: 'text', text: { body: 'Synthetic shipment details' }, ...extra });
function parse(messages, { sender = OWNER, waba = WABA, phone = PHONE } = {}) {
  const body = { object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phone }, contacts: [{ wa_id: sender, profile: { name: 'Synthetic owner' } }], messages,
  } }] }] };
  return JSON.parse(JSON.stringify(vm.runInNewContext('(function(){' + parseCode + '\n})()', { $input: { all: () => [{ json: { body } }] } })));
}
const document = (id, mime, filename) => msg(id, { type: 'document', document: { id: 'media-' + id, mime_type: mime, filename, caption: 'Synthetic caption ' + id } });
async function addFile(records, buffers) {
  const calls = [];
  const context = { Buffer, $input: { all: () => buffers.map(() => ({ binary: { data: {} } })) },
    $: name => { assert.equal(name, 'Parse'); return { itemMatching: i => { calls.push(i); return records[i]; } }; },
    helpers: { getBinaryDataBuffer: async i => buffers[i] },
  };
  const output = await vm.runInNewContext('(async function(){' + fileCode + '\n}).call({helpers})', context);
  return { output: JSON.parse(JSON.stringify(output)), calls };
}
test('parser accepts text, PDF, XLSX/XLS, JPEG/PNG documents and native images with captions', () => {
  const items = parse([msg('text'), document('pdf', 'application/pdf', 'a.pdf'), document('xlsx', XLSX, 'a.xlsx'),
    document('xls', XLS, 'a.xls'), document('jpg', 'image/jpeg', 'a.jpg'), document('png', 'image/png', 'a.png'),
    msg('image', { type: 'image', image: { id: 'photo-media', mime_type: 'image/jpeg', caption: 'Native photo caption' } })]);
  assert.deepEqual(items.map(x => x.json.messageId), ['text', 'pdf', 'xlsx', 'xls', 'jpg', 'png', 'image']);
  assert.equal(items.at(-1).json.fileName, 'photo.jpg');
  assert.equal(items.at(-1).json.body.caption, 'Native photo caption');
  assert.equal(items[2].json.body.caption, 'Synthetic caption xlsx');
  assert.equal(items[0].json.body.name, 'Synthetic owner');
});
test('parser retains scope, sender, ID and timestamp controls and filters unsupported media', () => {
  assert.deepEqual(parse([msg('text')], { waba: 'wrong' }), []);
  assert.deepEqual(parse([msg('text')], { phone: 'wrong' }), []);
  assert.deepEqual(parse([msg('other', { from: '1000000' }), msg('', {}), msg('bad time', { timestamp: 'no' })]), []);
  assert.deepEqual(parse([document('zip', 'application/zip', 'a.zip'), document('svg', 'image/svg+xml', 'a.svg'),
    document('bad-name', 'application/pdf', 'a.exe'), msg('not-image', { type: 'image', image: { id: 'bad', mime_type: XLSX } }),
    msg('audio', { type: 'audio' })]), []);
});
test('parser dedupes only accepted IDs and retains input pairing', () => {
  const items = parse([document('same', 'application/zip', 'a.zip'), document('same', 'application/pdf', 'a.pdf'), msg('same'), msg('next')]);
  assert.deepEqual(items.map(x => x.json.messageId), ['same', 'next']);
  assert.deepEqual(items.map(x => x.pairedItem), [{ item: 0 }, { item: 0 }]);
});
test('binary gate admits every supported format and retains paired captions/IDs/MIME', async () => {
  const inputs = [document('pdf', 'application/pdf', 'a.pdf'), document('xlsx', XLSX, 'a.xlsx'), document('xls', XLS, 'a.xls'),
    document('jpg', 'image/jpeg', 'a.jpg'), msg('png', { type: 'image', image: { id: 'png-media', mime_type: 'image/png', caption: 'PNG caption' } })];
  const records = parse(inputs), buffers = [fixtures.PDF, fixtures.workbookZip(), fixtures.workbookCfb(), fixtures.JPEG, fixtures.PNG];
  const { output, calls } = await addFile(records, buffers);
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  assert.deepEqual(output.map(x => x.pairedItem), [0, 1, 2, 3, 4].map(item => ({ item })));
  assert.deepEqual(output.map(x => x.json.body.message_id), ['pdf', 'xlsx', 'xls', 'jpg', 'png']);
  assert.equal(output.at(-1).json.body.caption, 'PNG caption');
  for (let i = 0; i < buffers.length; i++) assert.deepEqual(Buffer.from(output[i].json.body.file.base64, 'base64'), buffers[i]);
});
test('binary gate rejects MIME/signature mismatch, oversize and broken linkage with generic errors', async () => {
  const [record] = parse([document('pdf', 'application/pdf', 'a.pdf')]);
  const fail = /owner-linked PDF, XLSX\/XLS, JPG\/PNG of at most 10 MiB required/;
  await assert.rejects(addFile([record], [fixtures.JPEG]), fail);
  const large = Buffer.alloc(10 * 1024 * 1024 + 1); fixtures.PDF.copy(large);
  await assert.rejects(addFile([record], [large]), fail);
  for (const alter of [r => { r.json.body.from = 'other'; }, r => { r.json.messageId = 'other'; }, r => { r.json.body.type = 'audio'; }]) {
    const copy = structuredClone(record); alter(copy); await assert.rejects(addFile([copy], [fixtures.PDF]), fail);
  }
});
