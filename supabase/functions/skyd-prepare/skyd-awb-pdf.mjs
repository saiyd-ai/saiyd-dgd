/**
 * Browser-independent draft of DGDOC's mawbLayout. The server never supplies
 * signatures, stamps, or financial defaults that were absent from the source.
 * Use pdfLib injection in Node tests; Deno resolves the pinned npm dependency.
 */
export const AWB_PDF_DEPENDENCY = 'pdf-lib@1.17.1';
export const AWB_PAGE_SIZE = Object.freeze([595.2756, 841.8898]);

const TERMS = 'It is agreed that the goods described herein are accepted in apparent good order and condition (except as noted) for carriage SUBJECT TO THE CONDITIONS OF CONTRACT ON THE REVERSE HEREOF. ALL GOODS MAY BE CARRIED BY ANY OTHER MEANS INCLUDING ROAD OR ANY OTHER CARRIER UNLESS SPECIFIC CONTRARY INSTRUCTIONS ARE GIVEN HEREON BY THE SHIPPER, AND SHIPPER AGREES THAT THE SHIPMENT MAY BE CARRIED VIA INTERMEDIATE STOPPING PLACES WHICH THE CARRIER DEEMS APPROPRIATE. The shipper\'s attention is drawn to the notice concerning carrier\'s limitation of liability.';
const CERTIFICATION = 'Shipper certifies that the particulars on the face hereof are correct and that insofar as any part of the consignment contains dangerous goods, such part is properly described by name and is in proper condition for carriage by air according to the applicable Dangerous Goods Regulations.';
const FIELD_LIMIT = 20000;
const TOTAL_LIMIT = 80000;
const PAGE_LIMIT = 20;

function error(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function text(value, name = 'field') {
  if (value === null || value === undefined) return '';
  if (!['string', 'number'].includes(typeof value)) throw error('invalid_awb_pdf_field', `Invalid ${name}: expected text or number.`);
  const result = String(value).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/\u00a0/g, ' ');
  if (result.length > FIELD_LIMIT) throw error('awb_pdf_field_too_long', `${name} exceeds ${FIELD_LIMIT} characters; split the source before preparing a draft.`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(result)) throw error('invalid_awb_pdf_text', `${name} contains unsupported control characters.`);
  return result;
}

export function normalizeAwbPdfFields(fields = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw error('invalid_awb_pdf_fields', 'AWB fields must be an object.');
  const keys = ['awb', 'shipper', 'consignee', 'origin', 'destination', 'pieces', 'grossWeight', 'chargeableWeight', 'goods', 'dimensions', 'flight', 'date', 'handling', 'currency', 'rate', 'chargesPayment', 'carrier', 'issuer', 'agentIataCode', 'accounting', 'declaredValueCarriage', 'declaredValueCustoms', 'insurance', 'rateClass', 'otherCharges', 'executedPlace', 'chargesCode'];
  const o = Object.fromEntries(keys.map(key => [key, text(fields[key], key)]));
  const number = o.awb.replace(/[^0-9]/g, '');
  if (number && number.length !== 11) throw error('invalid_awb_pdf_number', 'AWB number must contain exactly 11 digits.');
  o.awb = number ? `${number.slice(0, 3)}-${number.slice(3)}` : '';
  o.prefix = number.slice(0, 3);
  o.serial = number.slice(3);
  o.goodsAndDimensions = [o.goods, o.dimensions].filter(Boolean).join('\n');
  const payment = o.chargesPayment.toUpperCase();
  if (payment && !['PREPAID', 'COLLECT'].includes(payment)) throw error('invalid_awb_pdf_payment', 'Charges payment must be PREPAID, COLLECT, or blank.');
  o.chargesPayment = payment;
  // Total is derived only from two explicitly supplied numeric values.
  const chargeable = Number(o.chargeableWeight), rate = Number(o.rate);
  o.total = o.chargeableWeight && o.rate && Number.isFinite(chargeable) && Number.isFinite(rate) && chargeable >= 0 && rate >= 0
    ? (chargeable * rate).toFixed(2) : '';
  if (Object.values(o).join('').length > TOTAL_LIMIT) throw error('awb_pdf_fields_too_long', 'AWB source exceeds the draft renderer limit.');
  return o;
}

async function loadPdfLib(injected) {
  if (injected) return injected;
  if (typeof Deno !== 'undefined') return import('npm:pdf-lib@1.17.1');
  return import('pdf-lib');
}

/** Every original field is rendered fully or carried to a labeled continuation. */
export async function renderAwbDraftPdf(fields, options = {}) {
  const lib = await loadPdfLib(options.pdfLib);
  const { PDFDocument, StandardFonts, rgb, degrees } = lib;
  const o = normalizeAwbPdfFields(fields);
  const jobNo = text(options.jobNo ?? '', 'jobNo');
  const version = text(options.version ?? 1, 'version');
  if (jobNo.length > 80 || version.length > 20 || /[^\x20-\x7e]/.test(jobNo + version)) throw error('invalid_awb_pdf_metadata', 'Invalid job number or draft version; use a single-line ASCII identifier.');
  const document = await PDFDocument.create();
  document.setTitle(`DRAFT AWB - ${jobNo || o.awb || 'Unassigned'} - v${version}`);
  document.setSubject('SKYD preparation draft; manual review required; not valid for carriage.');
  document.setCreator('DGDOC SKYD Draft Preparation');
  document.setProducer('DGDOC / pdf-lib');
  document.setLanguage('en-US');
  const labels = await document.embedFont(StandardFonts.Helvetica);
  const labelBold = await document.embedFont(StandardFonts.HelveticaBold);
  let values = await document.embedFont(StandardFonts.CourierBold);
  if (options.customFontBytes) {
    if (!options.fontkit) throw error('missing_awb_pdf_fontkit', 'A Unicode font requires the matching fontkit dependency.');
    document.registerFontkit(options.fontkit);
    values = await document.embedFont(options.customFontBytes, { subset: true });
  }
  const checkText = (value, fieldName) => {
    try { values.encodeText(value.replace(/\n/g, '')); }
    catch { throw error('unsupported_awb_pdf_text', `${fieldName} cannot be rendered by the configured font. Provide English/romanized AWB fields or configure a supported Unicode font; the original message remains in the job.`); }
  };
  Object.entries(o).forEach(([key, value]) => checkText(value, key));
  checkText(jobNo + version, 'job metadata');
  const [PW, PH] = AWB_PAGE_SIZE;
  const margin = 26, width = PW - margin * 2;
  const black = rgb(0, 0, 0), red = rgb(0.72, 0, 0), gray = rgb(0.22, 0.22, 0.22);
  const continuation = [];
  const continuationKeys = new Set();
  let page = document.addPage(AWB_PAGE_SIZE);
  const line = (x1, y1, x2, y2, thickness = 0.55) => page.drawLine({ start: { x: x1, y: PH - y1 }, end: { x: x2, y: PH - y2 }, thickness, color: black });
  const draw = (s, x, top, size = 8, font = values, color = black) => {
    if (s) page.drawText(s, { x, y: PH - top - size, size, font, color });
  };
  const wrap = (s, maxWidth, font, size) => {
    const lines = [];
    for (const paragraph of s.split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const word of paragraph.split(/\s+/u)) {
        if (!word) continue;
        const proposed = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(proposed, size) <= maxWidth) { current = proposed; continue; }
        if (current) { lines.push(current); current = ''; }
        let piece = '';
        for (const ch of word) {
          if (piece && font.widthOfTextAtSize(piece + ch, size) > maxWidth) { lines.push(piece); piece = ''; }
          piece += ch;
        }
        current = piece;
      }
      lines.push(current);
    }
    return lines;
  };
  const addContinuation = (key, heading, value) => {
    if (!continuationKeys.has(key)) { continuation.push({ heading, value }); continuationKeys.add(key); }
  };
  const cell = (x, top, w, h, label, value = '', { size = 8, key = label, continuationHeading = label, align = 'left', labelSize = 5.8, valueTop = 15, valueBottom = 2, font = values } = {}) => {
    page.drawRectangle({ x, y: PH - top - h, width: w, height: h, borderWidth: 0.55, borderColor: black });
    const labelLines = label ? wrap(label, w - 8, labels, labelSize) : [];
    labelLines.forEach((s, i) => draw(s, x + 4, top + 3 + i * (labelSize + 1), labelSize, labels, gray));
    if (!value) return;
    let all = wrap(value, w - 8, font, size);
    const start = Math.max(valueTop, labelLines.length ? 5 + labelLines.length * (labelSize + 1) : 3);
    const count = Math.max(0, 1 + Math.floor((h - start - valueBottom - size) / (size + 2)));
    if (all.length > count) {
      addContinuation(key, continuationHeading, value);
      all = [...all.slice(0, Math.max(0, count - 1)), '[See continuation]'];
      if (!count) throw error('awb_pdf_layout_overflow', `No readable space for ${label}.`);
    }
    all.forEach((s, i) => {
      let printedSize = size;
      while (font.widthOfTextAtSize(s, printedSize) > w - 8 && printedSize > 4) printedSize -= 0.25;
      if (font.widthOfTextAtSize(s, printedSize) > w - 8) s = '*';
      const sw = font.widthOfTextAtSize(s, printedSize);
      const tx = align === 'center' ? x + (w - sw) / 2 : align === 'right' ? x + w - 4 - sw : x + 4;
      draw(s, tx, top + start + i * (size + 2), printedSize, font);
    });
  };
  const plainBlock = (s, x, top, w, h, size = 5.5) => {
    const all = wrap(s, w, labels, size);
    if (all.length * (size + 1.3) > h) throw error('awb_pdf_layout_overflow', 'Contract text does not fit in the AWB layout.');
    all.forEach((value, i) => draw(value, x, top + i * (size + 1.3), size, labels));
  };
  let top = 24;
  cell(margin, top, 44, 18, '', o.prefix, { size: 10, valueTop: 3 });
  cell(margin + 44, top, 45, 18, '', o.origin, { size: 10, valueTop: 3 });
  cell(margin + 89, top, 116, 18, '', o.serial, { size: 10, valueTop: 3 });
  draw(o.awb, margin + width - values.widthOfTextAtSize(o.awb, 12), top + 1, 12);
  top += 20;
  const left = width / 2, party = left * 0.68, account = left - party;
  cell(margin, top, party, 64, "Shipper's Name and Address", o.shipper, { key: 'shipper', size: 8 });
  cell(margin + party, top, account, 64, "Shipper's Account Number");
  cell(margin, top + 64, party, 74, "Consignee's Name and Address", o.consignee, { key: 'consignee', size: 8 });
  cell(margin + party, top + 64, account, 74, "Consignee's Account Number");
  cell(margin + left, top, left, 138, 'Not Negotiable');
  draw('Air Waybill', margin + left + 6, top + 17, 17, labelBold);
  draw('Issued by', margin + left + 6, top + 45, 6.5, labels);
  if (o.carrier) {
    const carrierLines = wrap(o.carrier, left - 62, values, 8);
    if (carrierLines.length > 6) addContinuation('carrier', 'Issued by / carrier', o.carrier);
    carrierLines.slice(0, carrierLines.length > 6 ? 5 : 6).forEach((s, i) => draw(s, margin + left + 56, top + 43 + i * 10, 8));
    if (carrierLines.length > 6) draw('[See continuation]', margin + left + 56, top + 93, 8);
  }
  line(margin + left, top + 112, margin + width, top + 112);
  plainBlock('Copies 1, 2 and 3 of this Air Waybill are originals and have the same validity.', margin + left + 5, top + 119, left - 10, 15, 6);
  top += 138;
  cell(margin, top, left, 55, "Issuing Carrier's Agent Name and City", o.issuer, { key: 'issuer' });
  cell(margin + left, top, left, 55, '');
  plainBlock(TERMS, margin + left + 5, top + 4, left - 10, 47, 5.35);
  top += 55;
  cell(margin, top, left * 0.5, 28, "Agent's IATA Code", o.agentIataCode, { size: 8.5 });
  cell(margin + left * 0.5, top, left * 0.5, 28, 'Account No.');
  cell(margin + left, top, left, 28, 'Accounting Information', o.accounting, { key: 'accounting', size: 7 });
  top += 28;
  cell(margin, top, left, 58, 'Airport of Departure (Addr. of First Carrier) and Requested Routing', o.origin, { size: 10 });
  const cols = [0.15, 0.11, 0.16, 0.16, 0.21, 0.21];
  const chargeLabels = ['Currency', 'CHGS Code', 'WT/VAL\nPPD  COLL', 'Other\nPPD  COLL', 'Declared Value for Carriage', 'Declared Value for Customs'];
  const chargeValues = [o.currency, o.chargesCode, '', '', o.declaredValueCarriage, o.declaredValueCustoms];
  let cx = margin + left;
  cols.forEach((part, i) => {
    const w = left * part;
    cell(cx, top, w, 35, chargeLabels[i], chargeValues[i], { size: 7, valueTop: 22 });
    if ([2, 3].includes(i) && o.chargesPayment) draw('X', cx + (o.chargesPayment === 'COLLECT' ? w * 0.69 : w * 0.20), top + 23, 7);
    cx += w;
  });
  cell(margin + left, top + 35, left * 0.25, 23, 'To', o.destination, { size: 8, valueTop: 11 });
  cell(margin + left * 1.25, top + 35, left * 0.75, 23, 'By First Carrier', o.carrier, { size: 7, valueTop: 11, key: 'routingCarrier' });
  top += 58;
  cell(margin, top, left * 0.68, 37, 'Airport of Destination', o.destination, { size: 10 });
  cell(margin + left * 0.68, top, left * 0.32, 37, 'Requested Flight / Date', [o.flight, o.date].filter(Boolean).join('\n'), { size: 7, key: 'flightDate' });
  cell(margin + left, top, left, 37, 'Amount of Insurance', o.insurance, { size: 8 });
  plainBlock('INSURANCE - If insurance is offered and requested, indicate the amount to be insured in the box above.', margin + left + 5, top + 26, left - 10, 10, 5.3);
  top += 37;
  cell(margin, top, width, 57, 'Handling Information', o.handling, { key: 'handling', size: 8, valueBottom: 18 });
  cell(margin + width - 48, top + 40, 48, 17, 'SCI');
  top += 57;
  const cargoCols = [0.08, 0.10, 0.035, 0.09, 0.11, 0.11, 0.13, 0.345];
  const cargoLabels = ['No. of Pieces\nRCP', 'Gross Weight', 'kg\nlb', 'Rate Class / Commodity Item No.', 'Chargeable Weight', 'Rate / Charge', 'Total', 'Nature and Quantity of Goods (incl. Dimensions or Volume)'];
  const cargoValues = [o.pieces, o.grossWeight, o.grossWeight ? 'K' : '', o.rateClass, o.chargeableWeight, o.rate, o.total, o.goodsAndDimensions];
  cx = margin;
  cargoCols.forEach((part, i) => {
    const w = width * part;
    cell(cx, top, w, 31, cargoLabels[i], '', { labelSize: 5.7 });
    cell(cx, top + 31, w, 120, '', cargoValues[i], { size: i === 7 ? 8 : 8.3, valueTop: 5, align: i === 7 ? 'left' : 'center', key: `cargo-${i}`, continuationHeading: cargoLabels[i].replace(/\n/g, ' ') });
    cell(cx, top + 151, w, 21, '', [o.pieces, o.grossWeight, o.grossWeight ? 'K' : '', '', '', '', o.total, ''][i], { size: 8, valueTop: 5, align: 'center' });
    cx += w;
  });
  top += 172;
  const chargesWidth = width * 0.44, remainder = width - chargesWidth, small = chargesWidth / 2;
  const financialLabels = [['Prepaid / Weight Charge', 'Collect'], ['Valuation Charge', 'Tax'], ['Total Other Charges Due Agent', 'Total Other Charges Due Carrier'], ['Total Prepaid', 'Total Collect']];
  financialLabels.forEach((pair, i) => {
    pair.forEach((caption, j) => {
      const v = [0, 3].includes(i) && ((j === 0 && o.chargesPayment === 'PREPAID') || (j === 1 && o.chargesPayment === 'COLLECT')) ? o.total : '';
      cell(margin + j * small, top + i * 27, small, 27, caption, v, { size: 7.5 });
    });
  });
  cell(margin + chargesWidth, top, remainder, 24, 'Other Charges', o.otherCharges, { key: 'otherCharges', size: 7, valueTop: 12 });
  cell(margin + chargesWidth, top + 24, remainder, 84, '');
  plainBlock(CERTIFICATION, margin + chargesWidth + 5, top + 25, remainder - 10, 32, 5.8);
  line(margin + chargesWidth + 8, top + 64, margin + width - 8, top + 64);
  draw('Signature of Shipper or his Agent - not signed', margin + chargesWidth + 8, top + 66, 5.8, labels);
  const signTop = top + 83;
  line(margin + chargesWidth + 4, signTop, margin + width - 4, signTop);
  draw('Executed on (date)', margin + chargesWidth + 5, signTop + 2, 5.7, labels);
  draw('at (place)', margin + chargesWidth + 98, signTop + 2, 5.7, labels);
  draw('Signature of Issuing Carrier / Agent', margin + chargesWidth + 163, signTop + 2, 5.7, labels);
  const dateOverflow = /\n/.test(o.date) || values.widthOfTextAtSize(o.date, 7) > 88;
  const placeOverflow = /\n/.test(o.executedPlace) || values.widthOfTextAtSize(o.executedPlace, 7) > 59;
  draw(dateOverflow ? '[See cont.]' : o.date, margin + chargesWidth + 5, signTop + 12, 7);
  draw(placeOverflow ? '[See cont.]' : o.executedPlace, margin + chargesWidth + 98, signTop + 12, 7);
  if (dateOverflow) addContinuation('executedDate', 'Executed on (date)', o.date);
  if (placeOverflow) addContinuation('executedPlace', 'Executed at (place)', o.executedPlace);
  top += 108;
  cell(margin, top, chargesWidth, 22, "Currency Conversion Rates / CC Charges in Destination Currency / For Carrier's Use Only / Charges at Destination", '', { labelSize: 5.1 });
  cell(margin + chargesWidth, top, remainder, 22, '', o.awb, { size: 10, valueTop: 5, align: 'right' });
  top += 22;
  draw('Draft copy for review - no signature or stamp', margin + 118, top + 4, 8, labelBold);

  const reviewNotes = (options.reviewNotes || []).map((v, i) => text(v, `reviewNotes[${i}]`)).filter(Boolean);
  reviewNotes.forEach((v, i) => { checkText(v, 'review notes'); addContinuation(`review-${i}`, 'Review note', v); });
  for (const section of continuation) {
    const heading = text(section.heading);
    const lines = wrap(section.value, width - 20, values, 9);
    let index = 0;
    while (index < lines.length) {
      if (document.getPageCount() >= PAGE_LIMIT) throw error('awb_pdf_too_many_pages', `Draft exceeds ${PAGE_LIMIT} pages; split the source before preparing it.`);
      page = document.addPage(AWB_PAGE_SIZE);
      draw('AIR WAYBILL DRAFT - CONTINUATION', margin, 26, 13, labelBold);
      const headerLines = wrap(`${jobNo}  |  AWB ${o.awb}  |  Version ${version}`, width, values, 8);
      headerLines.forEach((v, i) => draw(v, margin, 48 + i * 10, 8));
      const ruleTop = 57 + headerLines.length * 10;
      line(margin, ruleTop, margin + width, ruleTop);
      draw(heading + (index ? ' (continued)' : ''), margin + 10, ruleTop + 11, 10, labelBold);
      const count = Math.min(61, lines.length - index);
      lines.slice(index, index + count).forEach((v, i) => draw(v, margin + 10, ruleTop + 32 + i * 11, 9));
      index += count;
    }
  }
  const pages = document.getPages();
  pages.forEach((p, i) => {
    p.drawText('DRAFT', { x: 111, y: 367, size: 72, font: labelBold, color: red, rotate: degrees(28), opacity: 0.11 });
    p.drawLine({ start: { x: margin, y: 29 }, end: { x: PW - margin, y: 29 }, color: red, thickness: 0.55 });
    const footer = `DRAFT - FOR REVIEW ONLY - NOT VALID FOR CARRIAGE | Job ${jobNo} | v${version} | ${i + 1}/${pages.length}`;
    let fs = 6.4;
    while (labels.widthOfTextAtSize(footer, fs) > width && fs > 4.5) fs -= 0.1;
    p.drawText(footer, { x: margin, y: 18, size: fs, font: labels, color: red });
  });
  return document.save({ useObjectStreams: false });
}
