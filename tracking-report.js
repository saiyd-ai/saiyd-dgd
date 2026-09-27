(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DgTrackingReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  let active = null;
  let sequence = 0;
  const text = value => value == null ? '' : String(value);
  const escape = value => text(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const array = value => Array.isArray(value) ? value : [];
  function validDate(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function dateText(value) {
    const date = validDate(value);
    return date ? date.toLocaleString('en-GB', {timeZone:'Asia/Dubai',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) + ' Dubai (UTC+4)' : 'Not available';
  }
  function dateMarkup(value, empty = 'Not available') {
    const date = validDate(value);
    return date ? '<time datetime="' + date.toISOString() + '">' + escape(dateText(value)) + '</time>' : '<span class="dgdoc-report-muted">' + escape(empty) + '</span>';
  }
  function awbText(value) {
    const original = text(value).trim(), digits = original.replace(/[-\s]/g,'');
    return /^\d{11}$/.test(digits) ? digits.slice(0,3) + '-' + digits.slice(3) : original || 'No AWB';
  }
  function latestManual(row) {
    return array(row.manualEvents).filter(event => event && event.source === 'Manual entry').slice().sort((a,b) => (validDate(a.ts)?.getTime() || 0) - (validDate(b.ts)?.getTime() || 0)).at(-1);
  }
  function routePart(value) {
    const label = text(value).trim();
    return /ADDR\.? OF FIRST CARRIER|REQUESTED ROUTING|ROUTING REFERENCE|OPTIONAL SHIPPING|DESTINATION TO BY|BY FIRST CARRIER|WT VAL/i.test(label) ? 'Needs review — check saved AWB details' : label || 'Not provided';
  }
  function reportRow(row, context) {
    const provider = row.providerResult && row.providerResult.provider === 'trackcargo' ? row.providerResult : null;
    const failed = provider && provider.dataStatus === 'ERROR';
    const status = failed ? 'Tracking unavailable' : text(row.status) || 'Not retrieved';
    const meanings = {RCF:'Received from flight',RCS:'Received from shipper',DEP:'Departed',ARR:'Arrived',DLV:'Delivery event',NFD:'Consignee notified',BKD:'Booked'};
    const description = provider && provider.dataStatus === 'AVAILABLE' ? text(provider.statusDescription) || meanings[status] || '' : failed ? 'The tracking result could not be retrieved.' : status === 'Awaiting carrier result' ? 'Awaiting an airline response.' : status === 'Not linked to TrackCargo' ? 'No tracking order linked.' : '';
    const refreshIssue = text(row.refreshError || context.error).trim();
    const manual = latestManual(row);
    const fallbackPrefix = text(row.awb).replace(/[-\s]/g,'').match(/^(\d{3})\d{8}$/);
    const airline = text(row.airlineName).trim() || (fallbackPrefix ? 'Airline prefix ' + fallbackPrefix[1] : 'Manual record');
    const reasons = array(row.attentionReasons).filter(reason => typeof reason === 'string' && reason.trim());
    const eventTime = failed ? '<span class="dgdoc-report-muted">Unavailable — retrieval failed</span>' : dateMarkup(row.lastUpdate, provider ? 'No carrier event time returned' : 'No carrier result retrieved');
    return '<tr><td><strong class="dgdoc-report-awb">' + escape(awbText(row.awb)) + '</strong><span class="dgdoc-report-muted">' + escape(airline) + '</span><p class="dgdoc-report-route">' + escape(routePart(row.origin)) + '<span aria-label="to"> → </span>' + escape(routePart(row.destination)) + '</p>' + (row.consignee ? '<span class="dgdoc-report-muted">Consignee: ' + escape(row.consignee) + '</span>' : '') + '</td>' +
      '<td><span class="dgdoc-report-source">TrackCargo · carrier result</span><strong>' + escape(status) + '</strong>' + (description ? '<p>' + escape(description) + '</p>' : '') + (provider && provider.currentLocation ? '<p>Event location: ' + escape(provider.currentLocation) + '</p>' : '') + (refreshIssue && provider ? '<p class="dgdoc-report-warning">Not refreshed — previous saved result. ' + escape(refreshIssue) + '</p>' : '') + (reasons.length ? '<ul class="dgdoc-report-attention">' + reasons.map(reason => '<li>' + escape(reason) + '</li>').join('') + '</ul>' : '') + '</td>' +
      '<td>' + eventTime + '</td><td>' + dateMarkup(row.fetchedAt, 'Not checked for this AWB') + '</td>' +
      '<td>' + (manual ? '<span class="dgdoc-report-source dgdoc-report-manual">Manual entry · operator recorded</span><strong>' + escape(manual.code || 'NOTE') + '</strong>' + (manual.note ? '<p class="dgdoc-report-manual-note">' + escape(manual.note) + '</p>' : '') + '<p class="dgdoc-report-muted">Recorded: ' + dateMarkup(manual.ts) + '</p>' : '<span class="dgdoc-report-muted">No manual entry</span>') + '</td></tr>';
  }
  function render(rows, context = {}) {
    const records = array(rows).filter(row => row && typeof row === 'object');
    const generatedAt = context.generatedAt == null ? new Date() : context.generatedAt;
    return '<article class="dgdoc-shipment-report"><header class="dgdoc-report-header"><div><p class="dgdoc-report-eyebrow">DGDOC · JFS LOGISTICS</p><h1>Shipment tracking report</h1><p>Saved results · current view</p></div><div class="dgdoc-report-generated"><b>Report generated</b>' + dateMarkup(generatedAt) + '</div></header>' +
      '<section class="dgdoc-report-summary" aria-label="Report scope"><p><b>' + records.length + '</b> shipment' + (records.length === 1 ? '' : 's') + '</p><p><b>View:</b> ' + escape(context.filterSummary || 'All saved shipments') + '</p><p><b>Last report retrieval:</b> ' + dateMarkup(context.checkedAt, 'No report retrieval recorded') + '</p></section>' +
      '<p class="dgdoc-report-disclaimer">This report uses saved data and does not fetch new tracking results. Carrier event time, last checked time and manual recording time are separate. All displayed times are Dubai (UTC+4).</p>' +
      (context.error ? '<p class="dgdoc-report-alert">Latest refresh was unsuccessful. ' + escape(context.error) + '</p>' : '') +
      '<table class="dgdoc-report-table"><thead><tr><th scope="col">Shipment / route</th><th scope="col">Latest carrier result</th><th scope="col">Carrier event time</th><th scope="col">Last checked</th><th scope="col">Manual update</th></tr></thead><tbody>' + (records.length ? records.map(row => reportRow(row, context)).join('') : '<tr><td colspan="5" class="dgdoc-report-empty">No shipments match this view.</td></tr>') + '</tbody></table>' +
      '<footer class="dgdoc-report-footer">Saved report · The latest carrier event may cover only part of a shipment. Planned events do not confirm arrival or delivery. A manual entry records an operator update and is not an automatically verified carrier event.</footer></article>';
  }
  function close() { if (active) active.close(); }
  function open(rows, context = {}) {
    const doc = root.document;
    if (!doc || !doc.body || typeof doc.createElement !== 'function') throw new Error('Report preview requires a browser document.');
    close();
    const priorFocus = doc.activeElement;
    const overlay = doc.createElement('div');
    const titleId = 'dgdoc-report-preview-title-' + (++sequence);
    overlay.className = 'dgdoc-report-overlay';
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-labelledby',titleId);
    overlay.innerHTML = '<div class="dgdoc-report-toolbar"><div><strong id="' + titleId + '">Shipment report preview</strong><span>Review the saved report, then print or save as PDF.</span></div><div class="dgdoc-report-toolbar-actions"><button type="button" data-report-action="print">Print / Save PDF</button><button type="button" data-report-action="close">Close</button></div></div><div class="dgdoc-report-preview-body" tabindex="0" role="region" aria-label="Shipment report">' + render(rows, context) + '</div>';
    const printButton = overlay.querySelector('[data-report-action="print"]');
    const closeButton = overlay.querySelector('[data-report-action="close"]');
    const scrollRegion = overlay.querySelector('.dgdoc-report-preview-body');
    const inertState = [...doc.body.children].map(element => ({element,had:element.hasAttribute('inert'),value:element.getAttribute('inert')}));
    const hadBodyClass = doc.body.classList.contains('dgdoc-report-open');
    const previousOverflow = doc.body.style.overflow;
    let closed = false;
    const controller = {close() {
      if (closed) return;
      closed = true;
      overlay.removeEventListener('keydown',onKey);
      printButton.removeEventListener('click',onPrint);
      closeButton.removeEventListener('click',onClose);
      overlay.remove();
      for (const saved of inertState) {
        if (saved.had) saved.element.setAttribute('inert',saved.value == null ? '' : saved.value);
        else saved.element.removeAttribute('inert');
      }
      if (!hadBodyClass) doc.body.classList.remove('dgdoc-report-open');
      doc.body.style.overflow = previousOverflow;
      if (active === controller) active = null;
      if (priorFocus && priorFocus.isConnected && typeof priorFocus.focus === 'function') priorFocus.focus({preventScroll:true});
    }};
    function onClose() { controller.close(); }
    function onPrint() { if (typeof root.print === 'function') root.print(); }
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); controller.close(); }
      if (event.key === 'Tab') {
        const focusables = [printButton,closeButton,scrollRegion];
        const index = focusables.indexOf(doc.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); scrollRegion.focus(); }
        else if (!event.shiftKey && (index < 0 || index === focusables.length - 1)) { event.preventDefault(); printButton.focus(); }
      }
    }
    printButton.addEventListener('click',onPrint); closeButton.addEventListener('click',onClose); overlay.addEventListener('keydown',onKey);
    doc.body.appendChild(overlay);
    for (const saved of inertState) saved.element.setAttribute('inert','');
    doc.body.classList.add('dgdoc-report-open'); doc.body.style.overflow = 'hidden';
    active = controller; closeButton.focus();
    return controller.close;
  }
  return {render,open,close};
});
