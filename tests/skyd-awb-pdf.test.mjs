import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderAwbDraftPdf, normalizeAwbPdfFields, AWB_PAGE_SIZE } from '../supabase/functions/skyd-prepare/skyd-awb-pdf.mjs';

const require = createRequire(import.meta.url);
// The explicit alternate directory supports the bundled Codex runtime without
// baking a workstation path into this source. CI uses normal npm dependencies.
const search = process.env.CODEX_WORKSPACE_NODE_MODULES ? [process.env.CODEX_WORKSPACE_NODE_MODULES] : undefined;
const pdfLib = require(require.resolve('pdf-lib', { paths: search }));
const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: search })).href);
const sample = {
  awb: '02012345675', shipper: 'DEMO SHIPPING SERVICES LLC\nPort Saeed, Dubai\nUNITED ARAB EMIRATES',
  consignee: 'DEMO CARGO SOLUTIONS\n8411 NW 74th Street\nMiami FL 33166, UNITED STATES',
  origin: 'DWC', destination: 'MIA', pieces: 27, grossWeight: 10284,
  goods: 'CONSOLIDATION CARGO AS PER ATTACHED HOUSE MANIFEST\n27 PALLETS STC 490 MASTER CARTONS\nHS CODE 33030010, 27 SLAC',
  dimensions: 'VOLUME 39.62 CBM', handling: 'SHC-RMD/EAW\nREVIEW HOUSE MANIFEST BEFORE FINAL APPROVAL', carrier: 'LUFTHANSA',
};
async function inspect(bytes) {
  const loading = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await loading.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const p = await doc.getPage(number);
    const content = await p.getTextContent();
    pages.push({ text: content.items.map(v => v.str).join(' ').replace(/\s+/g, ' '), items: content.items, view: p.view });
  }
  await loading.destroy();
  return pages;
}
function render(fields = sample, opts = {}) { return renderAwbDraftPdf(fields, { pdfLib, jobNo: 'AEXP-C00465', version: 2, ...opts }); }

test('A4 AWB draft has the current IATA-style sections and every source field', async () => {
  const bytes = await render();
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const loaded = await pdfLib.PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 1);
  const page = loaded.getPage(0);
  assert.ok(Math.abs(page.getWidth() - AWB_PAGE_SIZE[0]) < 0.01);
  assert.ok(Math.abs(page.getHeight() - AWB_PAGE_SIZE[1]) < 0.01);
  const pages = await inspect(bytes), content = pages[0].text;
  for (const value of ['Air Waybill', "Shipper's Name and Address", "Consignee's Name and Address", 'Handling Information', 'Nature and Quantity of Goods', '020-12345675', 'DEMO SHIPPING', 'DEMO CARGO', '39.62 CBM', '10284', 'AEXP-C00465', 'v2', 'DRAFT', 'NOT VALID FOR CARRIAGE']) assert.ok(content.includes(value), value);
  assert.equal(loaded.getForm().getFields().length, 0);
  for (const item of pages[0].items) {
    assert.ok(item.transform[4] >= 20 && item.transform[4] + item.width <= AWB_PAGE_SIZE[0] - 15, `Text exceeds A4 horizontal bounds: ${item.str}`);
    assert.ok(item.transform[5] >= 14 && item.transform[5] <= AWB_PAGE_SIZE[1] - 17, `Text exceeds A4 vertical bounds: ${item.str}`);
  }
});

test('unknown financial defaults and signatures are not invented', async () => {
  const pages = await inspect(await render());
  const content = pages.map(p => p.text).join('\n');
  for (const value of ['AED', 'NVD', 'NCV', 'NIL', 'PREPAID', 'DUBAI AIRPORT FREE ZONE', '8645305']) assert.ok(!content.includes(value), value);
  assert.ok(content.includes('not signed'));
  assert.equal(normalizeAwbPdfFields(sample).total, '');
  assert.equal(normalizeAwbPdfFields({ ...sample, rate: 2.5, chargeableWeight: 10500, chargesPayment: 'COLLECT' }).total, '26250.00');
});

test('long addresses, goods and handling remain complete on labeled continuation pages', async () => {
  const shipper = Array.from({ length: 25 }, (_, n) => `SHIPPER LINE ${n + 1} FULL ADDRESS`).join('\n');
  const consignee = 'RECIPIENT-' + 'ABC123'.repeat(75);
  const goods = Array.from({ length: 90 }, (_, n) => `GOODS LINE ${n + 1} PRESERVED IN DRAFT`).join('\n');
  const handling = Array.from({ length: 15 }, (_, n) => `HANDLING LINE ${n + 1} REVIEW SOURCE`).join('\n');
  const pages = await inspect(await render({ ...sample, shipper, consignee, goods, handling }));
  assert.ok(pages.length > 1);
  const all = pages.map(p => p.text).join('\n');
  for (const tail of ['SHIPPER LINE 25 FULL ADDRESS', 'GOODS LINE 90 PRESERVED IN DRAFT', 'HANDLING LINE 15 REVIEW SOURCE']) assert.ok(all.includes(tail), tail);
  assert.ok(all.includes('[See continuation]'));
  for (const p of pages) {
    assert.ok(p.text.includes('DRAFT') && p.text.includes('AEXP-C00465') && p.text.includes('NOT VALID FOR CARRIAGE'));
    for (const item of p.items) {
      assert.ok(item.transform[4] >= 20 && item.transform[4] + item.width <= AWB_PAGE_SIZE[0] - 15, `Continuation text exceeds page width: ${item.str}`);
      assert.ok(item.transform[5] >= 14 && item.transform[5] <= AWB_PAGE_SIZE[1] - 17, `Continuation text exceeds page height: ${item.str}`);
    }
  }
  const compact = all.replace(/\s/g, '');
  assert.ok(compact.includes(consignee));
});

test('six-line carrier text is not silently lost and long signed-date fields continue', async () => {
  const carrier = Array.from({ length: 6 }, (_, n) => `CARRIER LINE ${n + 1}`).join('\n');
  const date = 'DATE DETAILS '.repeat(12) + 'DATE-END';
  const executedPlace = 'CITY DETAILS '.repeat(12) + 'CITY-END';
  const content = (await inspect(await render({ ...sample, carrier, date, executedPlace }))).map(p => p.text).join('\n');
  assert.ok(content.includes('CARRIER LINE 6'));
  assert.ok(content.includes('DATE-END'));
  assert.ok(content.includes('CITY-END'));
});

test('unsupported script and oversized source fail clearly instead of producing missing glyphs', async () => {
  await assert.rejects(render({ ...sample, shipper: 'മലയാളം' }), { code: 'unsupported_awb_pdf_text' });
  await assert.rejects(render({ ...sample, goods: 'x'.repeat(20001) }), { code: 'awb_pdf_field_too_long' });
  await assert.rejects(render({ ...sample, goods: 'Line\u0000A' }), { code: 'invalid_awb_pdf_text' });
  await assert.rejects(render({ ...sample, chargesPayment: 'ANYTHING' }), { code: 'invalid_awb_pdf_payment' });
  await assert.rejects(render(sample, { jobNo: 'a\nb' }), { code: 'invalid_awb_pdf_metadata' });
});

test('draft text normalizes typographic dashes and does not allow an injected signature', async () => {
  const pages = await inspect(await render({ ...sample, goods: 'CARGO – GENERAL “GOODS”', signHtml: '<img src="INJECTED-SIGNATURE-STAMP">', draft: false }));
  const content = pages[0].text;
  assert.ok(content.includes('CARGO - GENERAL "GOODS"'));
  assert.ok(content.includes('DRAFT'));
  assert.ok(!content.includes('INJECTED-SIGNATURE-STAMP'));
});
