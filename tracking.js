/* CargoAi tracking is read from our server. CargoAi credentials never enter this file. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DgTracking = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ENDPOINT = '/.netlify/functions/cargoai-tracking';
  const TRACKCARGO_ENDPOINT = '/.netlify/functions/trackcargo-tracking';
  const txt = value => value == null ? '' : String(value);
  const array = value => Array.isArray(value) ? value : [];
  const escapeHtml = value => txt(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function normalizeAwb(value) {
    const source = txt(value).trim();
    if (!/^[\d\s-]+$/.test(source)) return '';
    const awb = source.replace(/[\s-]/g, '');
    return /^\d{11}$/.test(awb) && Number(awb.slice(3, 10)) % 7 === Number(awb[10]) ? awb : '';
  }
  function displayAwb(value) { const awb = normalizeAwb(value); return awb ? awb.slice(0, 3) + '-' + awb.slice(3) : txt(value); }
  function airlineTrackingLink(value) {
    const digits = normalizeAwb(value);
    if (!digits) return null;
    const awb = displayAwb(digits), prefix = digits.slice(0, 3);
    if (prefix === '020') return {awb, carrier:'Lufthansa Cargo', mode:'direct', url:'https://www.lufthansa-cargo.com/en/eservices/etracking/tracking/-/awb/020/' + digits.slice(3) + '?searchFilter=awb'};
    if (prefix === '155') return {awb, carrier:'DHL Aviation', mode:'direct', url:'https://aviationcargo.dhl.com/track/' + digits};
    if (prefix === '098') return {awb, carrier:'Air India Cargo', mode:'copy', url:'https://aicargoportal.airindia.com/icargoneoportal/app/main/'};
    if (prefix === '147') return {awb, carrier:'Royal Air Maroc Cargo', mode:'copy', url:'https://ebooking.champ.aero/trace/AT/trace.asp', copyText:digits.slice(3), copyLabel:'Copy number', copyHint:'Prefix 147 is set; paste the 8-digit waybill number.'};
    return {awb, carrier:'track-trace airline directory', mode:'copy', url:'https://www.track-trace.com/aircargo'};
  }
  function airlineActions(value) {
    const link = airlineTrackingLink(value);
    if (!link) return '';
    return '<div class="tracking-airline-actions"><a class="smallbtn sb-blue tracking-airline-link" data-tracking-action="airline" href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(link.carrier + ' · opens in a new tab') + '">Track airline ↗</a>' + (link.mode === 'copy' ? '<button type="button" class="smallbtn sb-blue" data-tracking-action="copy-awb">' + escapeHtml(link.copyLabel || 'Copy AWB') + '</button>' : '') + '<small>' + escapeHtml(link.carrier) + (link.mode === 'copy' ? ' · ' + escapeHtml(link.copyHint || 'Copy AWB, then paste on the website.') : ' · AWB included in link.') + '</small></div>';
  }
  async function copyAwb(value) {
    const link = airlineTrackingLink(value);
    if (!link) return false;
    const message = node('tracking-action-message');
    const copyText = link.copyText || link.awb, label = link.copyText ? 'waybill number' : 'AWB';
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(copyText);
      if (message) message.textContent = 'Copied ' + copyText + '. Open “Track airline”. ' + (link.copyHint || 'Paste the AWB on the website.') + ' Saved report is not changed.';
      return true;
    } catch {
      if (message) message.textContent = 'Clipboard unavailable. Select and copy this ' + label + ': ' + copyText + '. Then open “Track airline”. ' + (link.copyHint || 'Paste it on the website.') + ' Saved report is not changed.';
      return false;
    }
  }
  function dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', {timeZone: 'UTC', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'}) + ' UTC';
  }
  function statusText(value) { return txt(value).trim().replace(/_/g, ' ') || 'Awaiting update'; }
  function shipmentStatus(shipment, configured) {
    const unknown = !shipment || !txt(shipment.status).trim() || txt(shipment.status).trim().toUpperCase() === 'UNKNOWN';
    if (unknown && (!shipment || !shipment.lastUpdate)) {
      const subscription = txt(shipment && shipment.subscriptionStatus).trim().toLowerCase();
      if (['active', 'pending', 'unknown'].includes(subscription)) return 'Awaiting first update';
      return configured ? 'Not tracked' : 'Tracking not connected';
    }
    return statusText(shipment.status);
  }
  function tone(value) {
    const status = statusText(value).toUpperCase();
    if (['DELIVERED', 'DLV', 'DELIVERY COMPLETED'].includes(status)) return 'delivered';
    if (['DEPARTED', 'DEP', 'IN TRANSIT', 'ARRIVED', 'ARR', 'RCF', 'RECEIVED FROM FLIGHT', 'AT DESTINATION', 'EN ROUTE'].includes(status)) return 'moving';
    if (/error|fail|reject|cancel/i.test(value)) return 'issue';
    return 'pending';
  }
  function collectShipments(joblog, documents) {
    const rows = new Map(), invalid = new Set();
    function add(record, documentIndex) {
      if (!record || typeof record !== 'object') return;
      const snap = record.snap && typeof record.snap === 'object' ? record.snap : {};
      const raw = record.awb || snap.awb || '';
      const awb = normalizeAwb(raw);
      if (!awb) { if (txt(raw).trim()) invalid.add(txt(raw).trim()); return; }
      let row = rows.get(awb);
      if (!row) { row = {awb, jobs:[], origin:'', destination:'', route:'', shipper:'', consignee:''}; rows.set(awb, row); }
      const route = txt(record.route || '').trim();
      const parts = route.split(/\s+[-–→]\s+/);
      row.origin = txt(snap.dep || record.origin || row.origin || (parts.length === 2 ? parts[0] : ''));
      row.destination = txt(snap.dest || record.destination || row.destination || (parts.length === 2 ? parts[1] : ''));
      row.route = route || row.route;
      row.shipper = txt(record.shipper || snap.shipper || row.shipper).split('\n')[0];
      row.consignee = txt(record.consignee || snap.consignee || row.consignee).split('\n')[0];
      const job = txt(record.job || snap.job || '').trim();
      if (job) {
        let linked = row.jobs.find(item => item.job === job);
        if (!linked) { linked = {job, documentIndex:null, documentStatus:''}; row.jobs.push(linked); }
        if (Number.isInteger(documentIndex)) {
          linked.documentIndex = documentIndex;
          linked.documentStatus = record.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT';
        }
      }
    }
    array(joblog).slice().sort((a,b) => (a && a.last || 0) - (b && b.last || 0)).forEach(record => add(record));
    array(documents).map((record,index) => ({record,index})).sort((a,b) => (a.record && a.record.ts || 0) - (b.record && b.record.ts || 0)).forEach(({record,index}) => add(record, index));
    return {shipments:[...rows.values()], invalid:[...invalid]};
  }
  function withManualHistory(saved, manual) {
    const rows = new Map(array(saved).map(row => [row.awb, {...row, id:row.awb, jobs:row.jobs.map(job => ({...job})), manualRecords:[], manualEvents:[]}]));
    if (!manual || typeof manual !== 'object' || Array.isArray(manual)) return [...rows.values()];
    Object.entries(manual).forEach(([key, record]) => {
      if (!record || typeof record !== 'object') return;
      const rawAwb = txt(record.awb || key), awb = normalizeAwb(rawAwb), id = awb || 'manual:' + key;
      let row = rows.get(id);
      if (!row) { row = {id,awb:awb || rawAwb,jobs:[],origin:'',destination:'',route:'',shipper:'',consignee:'',manualRecords:[],manualEvents:[]}; rows.set(id,row); }
      row.manualRecords.push({key,record});
      row.route = row.route || txt(record.route); row.shipper = row.shipper || txt(record.shipper); row.consignee = row.consignee || txt(record.consignee);
      if (record.job && !row.jobs.some(job => job.job === txt(record.job))) row.jobs.push({job:txt(record.job),documentIndex:null,documentStatus:''});
      array(record.milestones).forEach(event => {
        if (!event || typeof event !== 'object') return;
        row.manualEvents.push({...event,recordKey:key,source:/cargo|api|auto/i.test(txt(event.src)) ? 'Legacy imported entry' : 'Manual entry'});
      });
    });
    return [...rows.values()].map(row => {
      row.manualEvents.sort((a,b) => (Number(a.ts) || Date.parse(a.ts) || 0) - (Number(b.ts) || Date.parse(b.ts) || 0));
      const last = row.manualEvents.at(-1);
      return {...row, manualStatus:last ? txt(last.code || last.note || 'UPDATE') : 'No manual update', lastManualEntry:last && last.ts || null};
    });
  }
  function importSavedAwbs(manual, joblog, documents) {
    const all = manual && typeof manual === 'object' && !Array.isArray(manual) ? {...manual} : {};
    const existing = new Set(Object.entries(all).map(([key,row]) => normalizeAwb(row && row.awb || key)).filter(Boolean));
    let added = 0;
    collectShipments(joblog,documents).shipments.forEach(row => {
      if (existing.has(row.awb)) return;
      const awb = displayAwb(row.awb);
      if (Object.prototype.hasOwnProperty.call(all,awb)) return;
      all[awb] = {awb,job:row.jobs[0] && row.jobs[0].job || '',route:[row.origin,row.destination].filter(Boolean).join(' - ') || row.route,shipper:row.shipper,consignee:row.consignee,milestones:[],updated:0};
      existing.add(row.awb); added++;
    });
    return {all,added};
  }
  function mergeManualStores(local, cloud) {
    const valid = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const left = valid(local), right = valid(cloud), result = Object.create(null);
    for (const key of new Set([...Object.keys(right), ...Object.keys(left)])) {
      const l = Object.prototype.hasOwnProperty.call(left,key) ? left[key] : undefined, r = Object.prototype.hasOwnProperty.call(right,key) ? right[key] : undefined;
      if (!l || !r || typeof l !== 'object' || typeof r !== 'object') { result[key] = l === undefined ? r : l; continue; }
      const localNewer = (Number(l.updated) || 0) >= (Number(r.updated) || 0), seen = new Set();
      const milestones = [...array(r.milestones), ...array(l.milestones)].filter(event => {
        const identity = event && typeof event === 'object' ? JSON.stringify(Object.keys(event).sort().map(field => [field,event[field]])) : JSON.stringify(event);
        if (seen.has(identity)) return false;
        seen.add(identity); return true;
      }).sort((a,b) => (Number(a && a.ts) || Date.parse(a && a.ts) || 0) - (Number(b && b.ts) || Date.parse(b && b.ts) || 0));
      result[key] = {...(localNewer ? r : l), ...(localNewer ? l : r), milestones};
    }
    return result;
  }
  function eventKind(event) {
    return [event.isPredicted === true ? 'Predicted' : event.isPlanned === true ? 'Planned' : event.isPlanned === false ? 'Actual' : 'Timing unclassified', event.isSplit === true ? 'Split shipment' : ''].filter(Boolean).join(' · ');
  }
  function eventSummary(event) {
    const flight = event.flight || {};
    return [event.code || event.status || 'Event',eventKind(event),dateText(event.eventDate),event.eventLocation || '',flight.number || event.flightNumber || '',event.pieces == null ? '' : event.pieces + ' pieces',event.weight == null ? '' : event.weight + ' kg',flight.actualDeparture ? 'Flight actual departure: ' + dateText(flight.actualDeparture) : '',flight.actualArrival ? 'Flight actual arrival: ' + dateText(flight.actualArrival) : ''].filter(Boolean).join(' | ');
  }
  function mergeTracking(localRows, trackingRows, configured) {
    const remote = new Map();
    array(trackingRows).forEach(row => {
      const awb = normalizeAwb(row && row.awb);
      if (awb) remote.set(awb, row);
    });
    return array(localRows).map(local => {
      const tracked = remote.get(local.awb);
      return {...local,
        origin:txt(tracked && tracked.origin || local.origin), destination:txt(tracked && tracked.destination || local.destination),
        status:normalizeAwb(local.awb) ? shipmentStatus(tracked, configured) : 'Manual only · invalid MAWB',
        flight:txt(tracked && tracked.flight), departedAt:tracked && tracked.departedAt || null,
        arrivedAt:tracked && tracked.arrivedAt || null, deliveredAt:tracked && tracked.deliveredAt || null,
        lastUpdate:tracked && tracked.lastUpdate || null, events:array(tracked && tracked.events),
        subscriptionStatus:txt(tracked && tracked.subscriptionStatus)
      };
    });
  }
  function filterShipments(rows, search, status) {
    const query = txt(search).toLowerCase().trim();
    return array(rows).filter(row => (!status || row.status === status) && (!query ||
      [row.awb, displayAwb(row.awb), row.origin, row.destination, row.route, row.shipper, row.consignee, row.status, row.manualStatus, row.flight, ...row.jobs.map(job => job.job)].join(' ').toLowerCase().includes(query)));
  }
  function csvCell(value) {
    let cell = txt(value).replace(/\u0000/g, '');
    // Spreadsheet programs may ignore leading control/whitespace before formulas.
    if (/^[\s\u0000-\u001f\u007f\ufeff]*[=+\-@]/.test(cell) || /^[\t\r\n]/.test(cell)) cell = "'" + cell;
    return '"' + cell.replace(/"/g, '""') + '"';
  }
  function toCsv(rows) {
    const columns = ['AWB','Linked jobs','Document status','Shipper','Consignee','Route','Origin','Destination','CargoAi shipment status','Flight','CargoAi actual departure (UTC)','CargoAi actual arrival (UTC)','CargoAi delivery (UTC)','Last CargoAi update (UTC)','Subscription status','Manual / legacy status','Last manual / legacy entry recorded (UTC)','CargoAi events (planned / predicted / split labeled)','Manual / legacy history (recorded times, not actual milestones)'];
    return '\ufeff' + [columns, ...array(rows).map(row => [displayAwb(row.awb), row.jobs.map(job => job.job).join('; '),
      row.jobs.map(job => job.job + ': ' + (job.documentStatus || 'No saved document')).join('; '), row.shipper, row.consignee, [row.origin,row.destination].filter(Boolean).join(' → ') || row.route,
      row.origin, row.destination, row.status, row.flight, dateText(row.departedAt), dateText(row.arrivedAt), dateText(row.deliveredAt), dateText(row.lastUpdate), row.subscriptionStatus,
      row.manualStatus || 'No manual update', dateText(row.lastManualEntry), array(row.events).map(eventSummary).join('\n'), array(row.manualEvents).map(event => [event.source,event.code,event.note,'Recorded: '+dateText(event.ts),event.by,event.recordKey].filter(Boolean).join(' | ')).join('\n')
    ])].map(cells => cells.map(csvCell).join(',')).join('\r\n');
  }
  const state = {configured:false, liveEnabled:false, shipments:[], loaded:false, loading:false, syncing:false, error:'', message:'', checkedAt:null, userId:null, generation:0};
  const trackcargo = {configured:false, shipments:[], loaded:false, loading:false, error:'', message:'', checkedAt:null};
  let options = {}, timer = null, detailId = null;
  function node(id) { return typeof document === 'undefined' ? null : document.getElementById(id); }
  function localData() {
    const data = collectShipments(options.readStore ? options.readStore('jfs_joblog') : [], options.readStore ? options.readStore('jfs_documents') : []);
    data.shipments = withManualHistory(data.shipments, options.readStore ? options.readStore('jfs_tracking') : {});
    return data;
  }
  function allRows() { return mergeTracking(localData().shipments, state.shipments, state.configured); }
  function visibleRows() { return filterShipments(allRows(), node('tracking-search') && node('tracking-search').value, node('tracking-filter') && node('tracking-filter').value); }
  function reportInfo(awb) {
    const normalized = normalizeAwb(awb);
    const manual = localData().shipments.find(row => normalized ? normalizeAwb(row.awb) === normalized : row.awb === awb || row.manualRecords.some(record => record.key === awb));
    if (!normalized) return {status:txt(awb).trim() ? 'Manual only · invalid MAWB' : 'No MAWB', lastUpdate:'—',manualStatus:manual && manual.manualStatus || 'No manual update',lastManualEntry:dateText(manual && manual.lastManualEntry)};
    const shipment = state.shipments.find(item => normalizeAwb(item.awb) === normalized);
    return {status:shipmentStatus(shipment, state.configured), lastUpdate:shipment ? dateText(shipment.lastUpdate) : '—',manualStatus:manual && manual.manualStatus || 'No manual update',lastManualEntry:dateText(manual && manual.lastManualEntry)};
  }
  function reportCells(awb, tdStyle) {
    const info = reportInfo(awb);
    return '<td style="' + escapeHtml(tdStyle) + '">' + escapeHtml(info.status) + '<small class="tracking-report-source">CargoAi</small></td><td style="' + escapeHtml(tdStyle) + '">' + escapeHtml(info.lastUpdate) + '</td><td style="' + escapeHtml(tdStyle) + '">' + escapeHtml(info.manualStatus || 'No manual update') + '<small class="tracking-report-source">Manual / legacy entry</small></td><td style="' + escapeHtml(tdStyle) + '">' + escapeHtml(info.lastManualEntry || '—') + '</td>';
  }
  function jobLink(job) {
    return '<div class="tracking-job"><button type="button" class="tracking-job-link" data-job="' + escapeHtml(job.job) + '"' + (job.documentIndex == null ? '' : ' data-document="' + job.documentIndex + '"') + '>' + escapeHtml(job.job) + '</button>' + (job.documentStatus ? '<span class="tracking-doc-status ' + (job.documentStatus === 'CONFIRMED' ? 'confirmed' : '') + '">' + escapeHtml(job.documentStatus) + '</span>' : '') + '</div>';
  }
  function trackcargoStatus(shipment) {
    if (shipment.dataStatus === 'ERROR') return 'TrackCargo unavailable';
    if (shipment.dataStatus !== 'AVAILABLE' || !txt(shipment.status).trim() || txt(shipment.status).toUpperCase() === 'UNKNOWN') return 'Awaiting carrier result';
    return statusText(shipment.status);
  }
  function trackcargoMetadata(shipment) {
    const order = statusText(shipment.orderStatus || 'unknown').toLowerCase();
    return 'TrackCargo order: ' + order.charAt(0).toUpperCase() + order.slice(1);
  }
  function trackcargoNotice(shipment) {
    return shipment.refreshError ? '<p class="trackcargo-message issue">Not refreshed: ' + escapeHtml(shipment.refreshError) + ' Showing the previous TrackCargo result.</p>' : shipment.message ? '<p class="trackcargo-message">' + escapeHtml(shipment.message) + '</p>' : '';
  }
  function renderTrackcargo() {
    const panel = node('trackcargo-panel');
    if (!panel) return;
    const active = typeof document !== 'undefined' && document.activeElement;
    const focusedAction = active && typeof panel.contains === 'function' && panel.contains(active) && active.dataset && active.dataset.trackcargoAction ? {action:active.dataset.trackcargoAction,awb:active.dataset.awb} : null;
    const note = trackcargo.error ? trackcargo.error + (trackcargo.shipments.length ? ' Showing the last retrieved TrackCargo results.' : '') : trackcargo.loading ? 'Reading existing TrackCargo orders…' : trackcargo.loaded ? trackcargo.message || (trackcargo.configured ? 'Existing TrackCargo orders retrieved.' : 'TrackCargo is not connected.') : 'Refresh to read the orders already in TrackCargo. This does not create new tracking orders.';
    panel.innerHTML = '<div class="trackcargo-header"><div><h3>TrackCargo <span>Existing orders</span></h3><p>Latest carrier events are shown separately from saved CargoAi status and manual history.</p></div><button type="button" class="smallbtn sb-blue" data-trackcargo-action="refresh"' + (trackcargo.loading ? ' aria-disabled="true"' : '') + '>' + (trackcargo.loading ? 'Refreshing TrackCargo…' : 'Refresh TrackCargo') + '</button></div><p class="trackcargo-message' + (trackcargo.error ? ' issue' : '') + '" role="status" aria-live="polite">' + escapeHtml(note) + '</p>' + (trackcargo.checkedAt ? '<p class="trackcargo-retrieved">Last retrieval ' + dateText(trackcargo.checkedAt) + ' · Refresh runs only when requested.</p>' : '') + (trackcargo.shipments.length ? '<div class="trackcargo-table-wrap"><table class="trackcargo-table"><thead><tr><th scope="col">AWB / route</th><th scope="col">Latest carrier event</th><th scope="col">Last actual event</th><th scope="col">Details</th></tr></thead><tbody>' + trackcargo.shipments.map(shipment => {
      const status = trackcargoStatus(shipment), row = getRow(shipment.awb);
      return '<tr><td data-label="AWB / route"><b>' + escapeHtml(displayAwb(shipment.awb)) + '</b><small>' + escapeHtml([shipment.origin,shipment.destination].filter(Boolean).join(' → ') || 'Route not returned') + '</small></td><td data-label="Latest carrier event"><span class="tracking-status ' + (shipment.dataStatus === 'ERROR' ? 'issue' : tone(status)) + '">' + escapeHtml(status) + '</span>' + (shipment.statusDescription ? '<small>' + escapeHtml(shipment.statusDescription) + '</small>' : '') + '<small>' + escapeHtml(trackcargoMetadata(shipment)) + '</small>' + trackcargoNotice(shipment) + '</td><td data-label="Last actual event">' + dateText(shipment.lastUpdate) + (shipment.currentLocation ? '<small>At ' + escapeHtml(shipment.currentLocation) + '</small>' : '') + '<small>Fetched ' + dateText(shipment.fetchedAt) + '</small></td><td data-label="Details">' + (row ? '<button type="button" class="smallbtn sb-blue" data-trackcargo-action="detail" data-awb="' + escapeHtml(row.id || row.awb) + '">View shipment</button>' : '<small>No linked saved shipment</small>') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '');
    if (focusedAction && typeof panel.querySelectorAll === 'function') {
      const button = [...panel.querySelectorAll('[data-trackcargo-action]')].find(item => item.dataset.trackcargoAction === focusedAction.action && item.dataset.awb === focusedAction.awb);
      if (button && !button.disabled) button.focus({preventScroll:true});
    }
  }
  function trackcargoDetail(row, open) {
    if (!normalizeAwb(row.awb)) return '';
    const shipment = trackcargo.shipments.find(item => normalizeAwb(item.awb) === normalizeAwb(row.awb));
    let body = '<p class="tracking-note">' + escapeHtml(trackcargo.error || (trackcargo.loaded ? 'No existing TrackCargo order was returned for this AWB.' : 'Use Refresh TrackCargo above to read existing orders.')) + '</p>';
    if (shipment) {
      const events = array(shipment.events).slice().sort((a,b) => (Date.parse(b.eventDate) || 0) - (Date.parse(a.eventDate) || 0));
      body = (trackcargo.error ? '<p class="trackcargo-message issue">' + escapeHtml(trackcargo.error) + ' Showing the last retrieved result.</p>' : '') + '<p class="trackcargo-detail-status">Latest carrier event <span class="tracking-status ' + (shipment.dataStatus === 'ERROR' ? 'issue' : tone(trackcargoStatus(shipment))) + '">' + escapeHtml(trackcargoStatus(shipment)) + '</span> ' + escapeHtml(trackcargoMetadata(shipment)) + '</p>' + (shipment.statusDescription ? '<p class="tracking-note">' + escapeHtml(shipment.statusDescription) + '</p>' : '') + (shipment.currentLocation ? '<p class="tracking-note">Current location ' + escapeHtml(shipment.currentLocation) + '</p>' : '') + trackcargoNotice(shipment) + '<dl class="tracking-dates trackcargo-dates">' + [['Origin departure event',shipment.departedAt],['Verified arrival',shipment.arrivedAt],['Verified delivery',shipment.deliveredAt],['Last actual event',shipment.lastUpdate],['Planned arrival',shipment.plannedArrivalAt],['Planned delivery',shipment.plannedDeliveryAt]].map(([label,value]) => '<div><dt>' + label + '</dt><dd>' + dateText(value) + '</dd></div>').join('') + '</dl><p class="tracking-note">Fetched from TrackCargo ' + dateText(shipment.fetchedAt) + '. TrackCargo times are UTC. The latest carrier event can refer to part of a shipment. Planned events are forecasts; they do not confirm arrival or delivery. Fetch time shows when this result was retrieved.</p><div class="tracking-history-list" tabindex="0" role="region" aria-label="TrackCargo event history">' + (events.map(event => '<div class="tracking-history-row"><b>' + escapeHtml(event.code || 'UPDATE') + '</b><div><strong>' + escapeHtml(eventKind(event)) + ' · TrackCargo</strong><p>' + escapeHtml(event.description || '') + '</p><p>' + escapeHtml(eventSummary(event)) + '</p>' + (event.timezone ? '<small>Event location timezone: ' + escapeHtml(event.timezone) + '</small>' : '') + '</div></div>').join('') || '<p class="tracking-note">No carrier events returned by TrackCargo.</p>') + '</div>';
    }
    return '<details class="trackcargo-detail" data-detail-section="trackcargo"' + open + '><summary>TrackCargo <span>Existing order · separate provider</span></summary><div class="trackcargo-detail-body">' + body + '</div></details>';
  }
  function render() {
    if (!node('tracking-body')) return;
    const tableBody = node('tracking-body');
    const expandedJobs = new Set(typeof tableBody.querySelectorAll === 'function' ? [...tableBody.querySelectorAll('details[data-job-group][open]')].map(detail => detail.dataset.jobGroup) : []);
    const all = allRows(), local = localData();
    const select = node('tracking-filter'), previous = select.value;
    select.innerHTML = '<option value="">All shipment statuses</option>' + [...new Set(all.map(row => row.status))].sort().map(status => '<option value="' + escapeHtml(status) + '">' + escapeHtml(status) + '</option>').join('');
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    const rows = visibleRows();
    node('tracking-total').textContent = all.filter(row => normalizeAwb(row.awb)).length;
    node('tracking-delivered').textContent = all.filter(row => tone(row.status) === 'delivered').length;
    node('tracking-moving').textContent = all.filter(row => tone(row.status) === 'moving').length;
    node('tracking-untracked').textContent = all.filter(row => normalizeAwb(row.awb) && !row.lastUpdate).length;
    node('tracking-count').textContent = rows.length + ' of ' + all.length + ' shipments';
    const manualOnly = all.filter(row => !normalizeAwb(row.awb)).length;
    node('tracking-invalid').textContent = manualOnly || local.invalid.length ? manualOnly + ' manual-only record(s) retained. Airline links require a valid master AWB; house AWBs and incomplete numbers remain available in saved history.' : '';
    const connection = node('tracking-connection');
    connection.className = 'tracking-connection ' + (state.error ? 'issue' : 'ready');
    node('tracking-connection-title').textContent = 'Manual airline checks available' + (state.error ? ' · Saved updates unavailable' : state.loading && !state.loaded ? ' · Checking saved updates…' : !state.loaded ? '' : state.liveEnabled ? ' · Automatic tracking enabled' : state.configured ? ' · Automatic tracking paused' : ' · Automatic tracking not connected');
    const connectionText = !state.configured ? 'Your saved AWBs and manual history remain available. Automatic tracking requires completed server setup.' : !state.liveEnabled ? 'Saved tracking updates can be viewed. New tracking requests remain paused until an administrator enables them with an application credit cap.' : 'Only stored shipment updates are refreshed here. “Track next AWB · CargoAi” starts at most one standard subscription (10 credits). To choose a specific AWB, open its details and Automatic tracking. The server enforces the configured application credit cap.';
    node('tracking-connection-text').textContent = state.error || 'Airline links open an external report. They do not change the status saved in DGDOC.';
    if (node('tracking-auto-status')) node('tracking-auto-status').textContent = state.error || [connectionText, state.message].filter(Boolean).join(' ');
    node('tracking-checked').textContent = state.checkedAt ? 'Report refreshed ' + dateText(state.checkedAt) : 'Saved updates not retrieved yet';
    node('tracking-sync').disabled = !state.configured || !state.liveEnabled || !!state.error || state.loading || state.syncing || !all.some(row => normalizeAwb(row.awb));
    node('tracking-refresh').disabled = state.loading || state.syncing;
    node('tracking-export').disabled = !rows.length;
    node('tracking-sync').textContent = state.syncing ? 'Starting CargoAi tracking…' : 'Track next AWB · CargoAi';
    node('tracking-body').innerHTML = rows.length ? rows.map(row => {
      const id = row.id || row.awb;
      const jobs = row.jobs.slice(0,1).map(jobLink).join('') + (row.jobs.length > 1 ? '<details class="tracking-more-jobs" data-job-group="' + escapeHtml(id) + '"' + (expandedJobs.has(id) ? ' open' : '') + '><summary>+' + (row.jobs.length - 1) + ' more job' + (row.jobs.length > 2 ? 's' : '') + '</summary>' + row.jobs.slice(1).map(jobLink).join('') + '</details>' : '');
      const route = [row.origin, row.destination].filter(Boolean).join(' → ') || row.route || 'Route not saved';
      const customer = row.consignee || row.shipper || '';
      return '<tr data-awb="' + escapeHtml(id) + '"><td class="tracking-awb" data-label="AWB / airline"><span class="tracking-awb-number">' + escapeHtml(displayAwb(row.awb)) + '</span>' + airlineActions(row.awb) + '</td><td data-label="Route / customer"><strong class="tracking-route">' + escapeHtml(route) + '</strong>' + (customer ? '<span class="tracking-customer" title="' + escapeHtml(customer) + '">' + escapeHtml(customer) + '</span>' : '<small>Customer not saved</small>') + '</td><td data-label="Saved status"><span class="tracking-status ' + tone(row.status) + '">' + escapeHtml(row.status) + '</span><small>' + (normalizeAwb(row.awb) ? 'CargoAi · saved status' : 'Manual record') + '</small></td><td data-label="Last update"><span class="tracking-update">' + dateText(row.lastUpdate) + '</span>' + (!row.lastUpdate ? '<small>No saved update</small>' : '') + '</td><td data-label="Linked jobs">' + (jobs || '<small>No linked job</small>') + '</td><td class="tracking-row-actions" data-label="Details"><button type="button" class="smallbtn sb-blue" data-tracking-action="timeline">View details</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="tracking-empty">' + (all.length ? 'No shipments match these filters.' : 'No saved AWBs yet. Save a shipment or add AWBs from your jobs.') + '</td></tr>';
    renderTrackcargo();
    if (detailId) renderDetail(detailId);
  }
  function getRow(id) {
    return allRows().find(row => row.id === id || row.awb === id || normalizeAwb(id) && normalizeAwb(row.awb) === normalizeAwb(id) || row.manualRecords.some(entry => entry.key === id));
  }
  function renderDetail(id, scroll) {
    const row = getRow(id), box = node('trk_detail');
    if (!row || !box) return;
    const same = detailId === (row.id || row.awb), savedCode = same && node('trk_ms') ? node('trk_ms').value : '', savedNote = same && node('trk_note') ? node('trk_note').value : '';
    const opened = same && typeof box.querySelectorAll === 'function' ? new Set([...box.querySelectorAll('details[data-detail-section][open]')].map(detail => detail.dataset.detailSection)) : null;
    const openSection = (name, initiallyOpen = false) => (opened ? opened.has(name) : initiallyOpen) ? ' open' : '';
    detailId = row.id || row.awb;
    const labels = options.milestones || {}, key = row.manualRecords.length ? row.manualRecords[0].key : displayAwb(row.awb);
    const history = row.manualEvents.slice().reverse().map(event => '<div class="tracking-history-row"><b>' + escapeHtml(event.code || 'UPDATE') + '</b><div><strong>' + escapeHtml(labels[event.code] || 'Saved update') + '</strong><p>' + escapeHtml(event.note || '') + '</p><small>' + escapeHtml(event.source) + ' · Recorded ' + dateText(event.ts) + (event.by ? ' · ' + escapeHtml(event.by) : '') + ' · Record ' + escapeHtml(event.recordKey) + '</small></div></div>').join('');
    const events = row.events.slice().sort((a,b) => (Date.parse(b.eventDate) || 0) - (Date.parse(a.eventDate) || 0)).map(event => {
      const flight = event.flight || {};
      return '<div class="tracking-history-row"><b>' + escapeHtml(event.code || 'UPDATE') + '</b><div><strong>' + escapeHtml(eventKind(event)) + '</strong><p>' + escapeHtml(eventSummary(event)) + '</p>' + ['scheduledDeparture','scheduledArrival','estimatedDeparture','estimatedArrival'].filter(field => flight[field]).map(field => '<small>' + escapeHtml(field.replace(/([A-Z])/g,' $1')) + ': ' + dateText(flight[field]) + '</small>').join('') + '</div></div>';
    }).join('');
    const route = [row.origin,row.destination].filter(Boolean).join(' → ') || row.route || 'Route not saved';
    box.innerHTML = '<section class="tracking-detail"><div class="tracking-detail-header"><div><small>SHIPMENT DETAILS</small><h3 id="tracking-detail-title" tabindex="-1">' + escapeHtml(displayAwb(row.awb)) + ' <span>' + escapeHtml(route) + '</span></h3></div><button type="button" class="smallbtn sb-blue" data-detail-action="close">Close details</button></div><div class="tracking-detail-body"><div class="tracking-parties"><p><b>Shipper</b>' + escapeHtml(row.shipper || 'Not saved') + '</p><p><b>Consignee</b>' + escapeHtml(row.consignee || 'Not saved') + '</p></div><dl class="tracking-dates">' + [['Actual departure',row.departedAt],['Actual arrival',row.arrivedAt],['Delivery',row.deliveredAt],['Last CargoAi update',row.lastUpdate]].map(([label,value]) => '<div><dt>' + label + '</dt><dd>' + dateText(value) + '</dd></div>').join('') + '</dl><p class="tracking-note">Dates above come from saved CargoAi updates. A dash means the date has not been verified. All times are UTC.</p><details class="tracking-flight-details" data-detail-section="flights"' + openSection('flights') + '><summary>Flight references</summary><p>' + escapeHtml(row.flight || 'No flight references received.') + '</p></details>' + trackcargoDetail(row, openSection('trackcargo',true)) + '<div class="tracking-timeline-grid"><details data-detail-section="events"' + openSection('events',true) + '><summary>CargoAi events <span>' + row.events.length + '</span></summary><div class="tracking-history-list" tabindex="0" role="region" aria-label="CargoAi event history">' + (events || '<p class="tracking-note">No CargoAi events received yet.</p>') + '</div></details><details data-detail-section="manual"' + openSection('manual',!row.events.length) + '><summary>Manual / legacy history <span>' + row.manualEvents.length + '</span></summary><div class="tracking-history-list" tabindex="0" role="region" aria-label="Manual event history">' + (history || '<p class="tracking-note">No manual entries yet.</p>') + '</div></details></div><p class="tracking-note">Manual entry times show when an update was recorded, not a verified departure, arrival or delivery.</p><div class="tracking-manual-form"><div><label for="trk_ms">Manual milestone</label><select id="trk_ms">' + Object.entries(labels).map(([code,label]) => '<option value="' + escapeHtml(code) + '">' + escapeHtml(label) + '</option>').join('') + '</select></div><div><label for="trk_note">Manual note / flight reference</label><input type="text" id="trk_note" placeholder="Flight number or operations remark"></div><button type="button" class="smallbtn sb-green" data-detail-action="add" data-record-key="' + escapeHtml(key) + '">Add manual update</button></div><details class="tracking-automatic" data-detail-section="automatic"' + openSection('automatic') + '><summary>Automatic tracking <span>CargoAi · this AWB</span></summary><div class="tracking-automatic-body"><p class="tracking-note">' + (normalizeAwb(row.awb) ? 'Starting a subscription uses CargoCONNECT credits and asks for confirmation. Saved status: ' + escapeHtml(row.subscriptionStatus || 'not subscribed') + '.' : 'This record is available for manual updates. Automatic tracking requires a valid master AWB.') + '</p><button type="button" class="smallbtn sb-blue" data-detail-action="auto"' + (!normalizeAwb(row.awb) || !state.configured || !state.liveEnabled || state.error || state.loading || state.syncing ? ' disabled' : '') + '>Start CargoAi tracking for this AWB</button></div></details></div></section>';
    if (savedCode && node('trk_ms')) node('trk_ms').value = savedCode;
    if (savedNote && node('trk_note')) node('trk_note').value = savedNote;
    if (scroll) {
      const heading = node('tracking-detail-title');
      if (heading && typeof heading.focus === 'function') heading.focus({preventScroll:true});
      if (typeof box.scrollIntoView === 'function') box.scrollIntoView({behavior:'auto',block:'start'});
    }
  }
  function closeDetail() {
    const previousId = detailId, body = node('tracking-body');
    detailId = null; node('trk_detail').innerHTML = '';
    const buttons = body && typeof body.querySelectorAll === 'function' ? [...body.querySelectorAll('[data-tracking-action="timeline"]')] : [];
    const trigger = buttons.find(button => {
      const row = button.closest('[data-awb]');
      return row && row.dataset.awb === previousId;
    });
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }
  async function session() {
    const result = options.getSession ? await options.getSession() : null;
    return result && result.data ? result.data.session : result;
  }
  function clearState() {
    state.generation++;
    Object.assign(state, {configured:false, liveEnabled:false, shipments:[], loaded:false, error:'', message:'', checkedAt:null, userId:null});
    Object.assign(trackcargo, {configured:false, shipments:[], loaded:false, loading:false, error:'', message:'', checkedAt:null});
    render();
    if (options.refreshReports) options.refreshReports();
  }
  async function request(init, endpoint = ENDPOINT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try { return await fetch(endpoint, {...init, signal:controller.signal}); }
    catch (error) { if (error.name === 'AbortError') throw new Error('The tracking service took too long to respond. Try refreshing again.'); throw error; }
    finally { clearTimeout(timeout); }
  }
  async function refreshTrackcargo() {
    if (trackcargo.loading) return;
    trackcargo.loading = true; trackcargo.error = ''; render();
    let generation = state.generation;
    try {
      const auth = await session();
      if (generation !== state.generation) return;
      if (!auth || !auth.access_token) { clearState(); generation = state.generation; trackcargo.error = 'Sign in to view TrackCargo orders.'; return; }
      if (state.userId && state.userId !== auth.user.id) clearState();
      state.userId = auth.user.id; generation = state.generation; trackcargo.loading = true;
      const response = await request({method:'GET', headers:{Authorization:'Bearer ' + auth.access_token}, cache:'no-store'}, TRACKCARGO_ENDPOINT);
      const payload = await response.json().catch(() => null);
      if (generation !== state.generation) return;
      if (response.status === 401 || response.status === 403) {
        trackcargo.shipments = []; trackcargo.loaded = false; trackcargo.checkedAt = null;
        throw new Error('Your account cannot access TrackCargo. Sign in again or contact your administrator.');
      }
      if (!response.ok && !(response.status === 503 && payload && payload.configured === false)) throw new Error('TrackCargo could not be refreshed. Try again shortly.');
      if (!payload || typeof payload.configured !== 'boolean' || payload.mode !== 'read_only' || !Array.isArray(payload.shipments)) throw new Error('TrackCargo returned an unexpected response. Contact your administrator.');
      trackcargo.configured = payload.configured;
      trackcargo.shipments = payload.shipments.filter(item => item && item.provider === 'trackcargo' && normalizeAwb(item.awb)).map(item => {
        const previous = trackcargo.shipments.find(saved => normalizeAwb(saved.awb) === normalizeAwb(item.awb));
        return item.dataStatus === 'ERROR' && previous && previous.dataStatus !== 'ERROR' ? {...previous,refreshError:item.message || 'TrackCargo did not return an updated result.'} : item;
      });
      trackcargo.message = typeof payload.message === 'string' ? payload.message.trim() : '';
      trackcargo.loaded = true; trackcargo.checkedAt = new Date().toISOString();
    } catch (error) { if (generation === state.generation) trackcargo.error = error.message || 'TrackCargo could not be refreshed.'; }
    finally { if (generation === state.generation) { trackcargo.loading = false; render(); } }
  }
  async function refresh() {
    if (state.loading) return;
    state.loading = true; render();
    let generation = state.generation;
    try {
      const auth = await session();
      if (generation !== state.generation) return;
      if (!auth || !auth.access_token) { clearState(); state.error = 'Sign in to view tracking updates.'; return; }
      if (state.userId && state.userId !== auth.user.id) clearState();
      state.userId = auth.user.id; generation = state.generation;
      const response = await request({headers:{Authorization:'Bearer ' + auth.access_token}, cache:'no-store'});
      const payload = await response.json().catch(() => null);
      if (generation !== state.generation) return;
      if (!response.ok && !(response.status === 503 && payload && payload.configured === false)) throw new Error(response.status === 401 || response.status === 403 ? 'Your account cannot access tracking. Sign in again or contact your administrator.' : 'Stored tracking updates could not be refreshed. Try again shortly.');
      if (!payload || typeof payload.configured !== 'boolean' || !Array.isArray(payload.shipments)) throw new Error('The tracking service returned an unexpected response. Contact your administrator.');
      state.configured = payload.configured; state.liveEnabled = payload.liveEnabled === true;
      state.message = typeof payload.message === 'string' ? payload.message.trim() : '';
      state.shipments = payload.shipments.filter(item => item && normalizeAwb(item.awb));
      state.error = response.status === 503 && typeof payload.error === 'string' ? payload.error : '';
      state.loaded = true;
      if (!state.error) state.checkedAt = new Date().toISOString();
    } catch (error) { if (generation === state.generation) state.error = error.message || 'Tracking could not be refreshed.'; }
    finally { state.loading = false; render(); if (options.refreshReports) options.refreshReports(); }
  }
  async function sync(selectedAwb) {
    if (!state.configured || !state.liveEnabled || state.error || state.syncing || state.loading) return;
    const targeted = typeof selectedAwb === 'string';
    const awb = targeted ? normalizeAwb(selectedAwb) : '';
    if (targeted && (!awb || !getRow(awb))) { node('tracking-action-message').textContent = 'Automatic tracking needs a valid master AWB already saved in this system.'; return; }
    if (!window.confirm('Start tracking ' + (targeted ? displayAwb(awb) : 'the next eligible saved master AWB') + '? One request can start at most one standard subscription (10 CargoCONNECT credits), within the configured application credit cap. This sends the AWB to CargoAi and uses your existing CargoCONNECT allowance. This action does not change your plan.')) return;
    state.syncing = true; node('tracking-action-message').textContent = ''; render();
    const generation = state.generation;
    try {
      const auth = await session();
      if (generation !== state.generation) return;
      if (!auth || !auth.access_token) throw new Error('Sign in before starting tracking.');
      if (options.prepareSync) await options.prepareSync();
      if (generation !== state.generation) return;
      const response = await request({method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + auth.access_token}, body:JSON.stringify(targeted ? {action:'sync',awb:displayAwb(awb)} : {action:'sync'})});
      const payload = await response.json().catch(() => null);
      if (generation !== state.generation) return;
      if (!response.ok) throw new Error(payload && (payload.message || payload.error) || 'Tracking could not be started. Try again or contact your administrator.');
      node('tracking-action-message').textContent = payload.message || 'Tracking request completed. Refresh the report to view saved updates.';
      await refresh();
    } catch (error) { if (generation === state.generation) node('tracking-action-message').textContent = error.message || 'Tracking could not be started.'; }
    finally { state.syncing = false; render(); }
  }
  function exportCsv() {
    const rows = visibleRows(); if (!rows.length) return;
    const url = URL.createObjectURL(new Blob([toCsv(rows)], {type:'text/csv;charset=utf-8;'}));
    const link = document.createElement('a'); link.href = url;
    link.download = 'DGDOC_Shipment_Tracking_' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function isVisible() { return !document.hidden && ['track','rpt','dash'].some(name => node('tab-' + name) && node('tab-' + name).classList.contains('on')); }
  function onTab(name) {
    if (name === 'track' || name === 'rpt' || name === 'dash') { render(); refresh(); }
  }
  function init(config) {
    options = config || {};
    if (node('trackcargo-panel')) node('trackcargo-panel').addEventListener('click', event => {
      const button = event.target.closest('[data-trackcargo-action]'); if (!button) return;
      if (button.dataset.trackcargoAction === 'refresh') return refreshTrackcargo();
      if (button.dataset.trackcargoAction === 'detail') renderDetail(button.dataset.awb, true);
    });
    node('tracking-search').addEventListener('input', render);
    node('tracking-filter').addEventListener('change', render);
    node('tracking-refresh').addEventListener('click', refresh);
    node('tracking-sync').addEventListener('click', () => sync());
    node('tracking-export').addEventListener('click', exportCsv);
    node('tracking-import').addEventListener('click', () => { if (options.importAwbs) options.importAwbs(); render(); });
    node('tracking-body').addEventListener('click', event => {
      const action = event.target.closest('[data-tracking-action]');
      if (action) {
        const parent = action.closest('[data-awb]'), row = parent && getRow(parent.dataset.awb);
        if (!row) return;
        if (action.dataset.trackingAction === 'copy-awb') return copyAwb(row.awb);
        if (action.dataset.trackingAction === 'airline') {
          const link = airlineTrackingLink(row.awb);
          if (link) node('tracking-action-message').textContent = 'Opening ' + link.carrier + ' for a manual check.' + (link.mode === 'copy' ? ' ' + (link.copyHint || 'Copy and paste AWB ' + link.awb + ' on the website.') : '') + ' Saved report is not changed.';
          return;
        }
        if (action.dataset.trackingAction === 'timeline') renderDetail(row.id || row.awb,true);
        if (action.dataset.trackingAction === 'auto') sync(row.awb);
        return;
      }
      const button = event.target.closest('[data-job]'); if (!button) return;
      // Shared documents can be reordered by a cloud sync after this row was drawn.
      const parent = button.closest('[data-awb]');
      const current = parent && getRow(parent.dataset.awb);
      const linked = current && current.jobs.find(job => job.job === button.dataset.job);
      if (linked && Number.isInteger(linked.documentIndex) && options.openDocument) options.openDocument(linked.documentIndex);
      else if (options.openJobReport) options.openJobReport(button.dataset.job);
    });
    node('trk_detail').addEventListener('click', event => {
      const button = event.target.closest('[data-detail-action]'); if (!button) return;
      if (button.dataset.detailAction === 'close') { closeDetail(); return; }
      if (button.dataset.detailAction === 'add' && options.addManual) options.addManual(button.dataset.recordKey);
      if (button.dataset.detailAction === 'auto') { const row = getRow(detailId); if (row) sync(row.awb); }
    });
    if (options.onAuthStateChange) options.onAuthStateChange((event, auth) => { if (!auth || state.userId && state.userId !== auth.user.id) clearState(); });
    document.addEventListener('visibilitychange', () => { if (isVisible()) refresh(); });
    window.addEventListener('storage', event => { if (['jfs_joblog','jfs_documents','jfs_tracking'].includes(event.key)) render(); });
    clearInterval(timer); timer = setInterval(() => { if (isVisible()) refresh(); }, 90000);
    render();
  }
  return {normalizeAwb, displayAwb, airlineTrackingLink, collectShipments, withManualHistory, importSavedAwbs, mergeManualStores, eventKind, eventSummary, mergeTracking, filterShipments, csvCell, toCsv, dateText, escapeHtml, statusText, init, onTab, refresh, refreshTrackcargo, sync, render, renderDetail, getRow, reportInfo, reportCells};
});
