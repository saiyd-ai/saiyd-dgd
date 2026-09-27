const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tracking = require('../tracking.js');
const AWB = '17612345675';
const TRACKCARGO_ENDPOINT = '/.netlify/functions/trackcargo-tracking';
const SNAPSHOT_PREFIX = 'dgdoc:trackcargo:snapshot:v1:';
const AWBS = ['02012345675','09812345675','09812345686','14712345675','15512345675'];
const legacy = {
  '176-12345675':{awb:'176-12345675',job:'DG-1',route:'DXB - LHR',milestones:[{code:'BKD',ts:1700000000000,note:'Booking entered',by:'Operator'}],updated:1700000000000},
  '17612345675':{awb:'17612345675',job:'GC-2',milestones:[{code:'DLV',ts:1700000010000,note:'Legacy imported',src:'CARGO CONNECT'}],updated:1700000010000},
  'HOUSE-SAMPLE-01':{awb:'HOUSE-SAMPLE-01',job:'DG-HOUSE',milestones:[{code:'DEP',ts:1700000020000,note:'Manual house entry'}],updated:1700000020000}
};

function trackcargoPayload() {
  const fetchedAt = '2026-09-27T01:00:00Z';
  return {configured:true,mode:'read_only',message:'Read existing TrackCargo orders only.',shipments:[
    {awb:AWBS[0],provider:'trackcargo',orderId:'existing-lh',orderStatus:'active',dataStatus:'AVAILABLE',status:'RCF',statusDescription:'Received from flight',statusScope:'latest_actual_event',origin:'DWC',destination:'JFK',currentLocation:'VIE',lastUpdate:'2026-09-24T22:03:00Z',fetchedAt,departedAt:'2026-09-23T04:58:00Z',arrivedAt:null,deliveredAt:null,plannedArrivalAt:'2026-09-28T00:05:00Z',plannedDeliveryAt:'2026-09-28T18:05:00Z',events:[
      {code:'RCF',description:'Received from flight',eventDate:'2026-09-24T22:03:00Z',eventLocation:'VIE',isPlanned:false,timeKind:'actual',pieces:'7',weight:'2721.5',flightNumber:'LH7562S',timezone:'Europe/Vienna'},
      {code:'DLV',description:'Delivered to consignee',eventDate:'2026-09-28T18:05:00Z',eventLocation:'JFK',isPlanned:true,timeKind:'planned',pieces:null,weight:null,timezone:'America/New_York'}
    ]},
    ...AWBS.slice(1,3).map((awb,i)=>({awb,provider:'trackcargo',orderId:'existing-ai-'+i,orderStatus:'pending',dataStatus:'INCONCLUSIVE',status:'UNKNOWN',lastUpdate:null,fetchedAt,events:[]}))
  ]};
}

function fixture(payload = {configured:false,mode:'read_only',shipments:[]}, status = 200, source = {}, config = {}) {
  const elements = new Map(), listeners = {}, requests = [], intervals = [], reportRenders = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id,value:'',innerHTML:'',textContent:'',disabled:false,options:[{value:''}],classList:{contains:() => id === 'tab-track'},addEventListener:(name, fn) => {listeners[id + ':' + name]=fn;}});
    return elements.get(id);
  };
  let authListener, confirmCount = 0;
  const auth = Object.prototype.hasOwnProperty.call(config,'auth') ? config.auth : {access_token:'fixture-only',user:{id:'fixture-user'}};
  const storage = config.storage || new Map(), storageControl = config.storageControl || {};
  const localStorage = {
    get length(){return storage.size;}, key:index=>[...storage.keys()][index] || null,
    getItem:key=>{if(storageControl.read) throw new Error('Storage read denied');return storage.has(key)?storage.get(key):null;},
    setItem:(key,value)=>{if(storageControl.write) throw new Error('Storage quota exceeded');storage.set(key,String(value));},
    removeItem:key=>{if(storageControl.remove) throw new Error('Storage removal denied');storage.delete(key);},
    clear:()=>storage.clear()
  };
  const sandbox = {module:{exports:{}},AbortController,console,Date,Blob,URL,localStorage,
    document:{hidden:false,getElementById:element,addEventListener:(name,fn)=>{listeners['document:'+name]=fn;}},
    window:{localStorage,addEventListener:(name,fn)=>{listeners['window:'+name]=fn;},confirm:()=>{confirmCount++;throw new Error('Tracking view must not prompt to start paid subscriptions');}},
    setInterval:fn=>{intervals.push(fn);return 1;},clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    fetch:async (url, init) => { requests.push({url,init});return {ok:status>=200&&status<300,status,json:async()=>payload}; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tracking.js'),'utf8'), sandbox);
  const api = sandbox.module.exports;
  const ready=Promise.resolve(api.init({readStore:key=>Object.prototype.hasOwnProperty.call(source,key) ? source[key] : key==='jfs_joblog'?[{awb:AWB,job:'<img src=x>',shipper:'Example'}]:[],getSession:config.getSession || (async()=>({data:{session:auth}})),onAuthStateChange:cb=>{authListener=cb;},refreshReports:()=>reportRenders.push(api.reportCells(AWB,'')),milestones:{BKD:'BOOKED',DEP:'DEPARTED',DLV:'DELIVERED'}}));
  return {api,requests,element,listeners,sandbox,auth,storage,storageControl,ready,intervals,reportRenders,authListener:()=>authListener,confirmCount:()=>confirmCount,setResponse:(p,s=200)=>{payload=p;status=s;}};
}

function clickTrackingAction(fixture, name, awb) {
  const action = {dataset:{trackingAction:name},closest:selector=>selector==='[data-awb]' ? {dataset:{awb}} : null};
  return fixture.listeners['tracking-body:click']({target:{closest:selector=>selector==='[data-tracking-action]' ? action : null},preventDefault:()=>{throw new Error('Native airline link should remain clickable');}});
}
function localSource() {
  return {jfs_joblog:AWBS.map((awb,i)=>({awb,job:'JOB-'+i,route:'DXB - JFK'})),jfs_tracking:{'020-12345675':{awb:'020-12345675',milestones:[{code:'DEP',note:'Manual note',ts:1}]}}};
}
function view(f) {
  return ['tracking-body','tracking-connection-title','tracking-connection-text','tracking-action-message','tracking-checked','trk_detail'].map(id=>f.element(id).innerHTML+' '+f.element(id).textContent).join('\n');
}


test('MAWB validation accepts formatting, rejects house AWBs, bad check digits and missing digits', () => {
  assert.equal(tracking.normalizeAwb(' 176-1234 5675 '), AWB);
  for (const value of ['HAWB-12345675', '17612345674', '1761234567', '176123456755', '<script>17612345675']) assert.equal(tracking.normalizeAwb(value), '');
});

test('airline links use verified direct routes or honest landing pages for validated MAWBs only', () => {
  const lufthansa = tracking.airlineTrackingLink(' 020-1234 5675 ');
  assert.equal(lufthansa.awb,'020-12345675');
  assert.equal(lufthansa.mode,'direct');
  assert.equal(lufthansa.url,'https://www.lufthansa-cargo.com/en/eservices/etracking/tracking/-/awb/020/12345675?searchFilter=awb');
  assert.equal(tracking.airlineTrackingLink('155-12345675').url,'https://aviationcargo.dhl.com/track/15512345675');
  assert.equal(tracking.airlineTrackingLink('15512345675').mode,'direct');
  for (const [awb,url,carrier] of [
    ['098-12345675','https://aicargoportal.airindia.com/icargoneoportal/app/main/','Air India Cargo'],
    ['147-12345675','https://ebooking.champ.aero/trace/AT/trace.asp','Royal Air Maroc Cargo'],
    ['999-12345675','https://www.track-trace.com/aircargo','track-trace airline directory']
  ]) {
    const link = tracking.airlineTrackingLink(awb);
    assert.equal(link.awb,awb);
    assert.equal(link.carrier,carrier);
    assert.equal(link.mode,'copy');
    assert.equal(link.url,url);
    assert.equal(new URL(url).search,'');
  }
  assert.equal(tracking.airlineTrackingLink('147-12345675').copyText,'12345675');
  assert.equal(tracking.airlineTrackingLink('147-12345675').copyLabel,'Copy number');
  for (const invalid of ['020-12345674','HAWB-12345675','020-1234567','javascript:alert(1)','\"><img src=x>02012345675','']) assert.equal(tracking.airlineTrackingLink(invalid),null);
});

test('one MAWB merges linked jobs and snapshots without changing document approvals', () => {
  const log = [{awb:AWB,job:'DG-1',route:'DXB - LHR'}, {awb:'176-12345675',job:'GC-2'}];
  const documents = [{job:'DG-1',status:'CONFIRMED',ts:2,snap:{awb:AWB,dep:'DXB',dest:'LHR'}}, {job:'GC-2',status:'DRAFT',snap:{awb:AWB}}, {job:'BAD',awb:'HAWB-123'}];
  const before = JSON.stringify({log,documents});
  const result = tracking.collectShipments(log, documents);
  assert.equal(result.shipments.length, 1);
  assert.deepEqual(result.shipments[0].jobs.map(job => job.documentStatus), ['CONFIRMED','DRAFT']);
  assert.deepEqual(result.invalid, ['HAWB-123']);
  assert.equal(result.shipments[0].destination, 'LHR');
  assert.equal(JSON.stringify({log,documents}), before);
});

test('newest duplicate document supplies the status and linked document index', () => {
  const rows = tracking.collectShipments([], [{awb:AWB,job:'DG-1',status:'CONFIRMED',ts:20},{awb:AWB,job:'DG-1',status:'DRAFT',ts:10}]).shipments;
  assert.equal(rows[0].jobs[0].documentStatus, 'CONFIRMED');
  assert.equal(rows[0].jobs[0].documentIndex, 0);
});

test('Copy AWB uses canonical text and leaves native navigation separate, including unavailable clipboard fallback', async () => {
  const source = {jfs_joblog:[{awb:'09812345675',job:'AIR-INDIA'},{awb:'14712345675',job:'ROYAL-AIR-MAROC'}]};
  const f = fixture(undefined,200,source), copied = [];
  f.sandbox.navigator = {clipboard:{writeText:async value=>copied.push(value)}};
  f.sandbox.window.open = () => { throw new Error('Clipboard action must not open an asynchronous popup'); };
  assert.equal(await clickTrackingAction(f,'copy-awb','09812345675'),true);
  assert.deepEqual(copied,['098-12345675']);
  assert.match(f.element('tracking-action-message').textContent,/Copied 098-12345675/);
  assert.equal(await clickTrackingAction(f,'copy-awb','14712345675'),true);
  assert.deepEqual(copied,['098-12345675','12345675']);
  assert.match(f.element('tracking-action-message').textContent,/Prefix 147 is set/);
  for (const clipboard of [undefined,{writeText:async()=>{ throw new Error('Denied'); }}]) {
    f.sandbox.navigator = {clipboard};
    assert.equal(await clickTrackingAction(f,'copy-awb','09812345675'),false);
    assert.match(f.element('tracking-action-message').textContent,/Select and copy this AWB: 098-12345675/);
    assert.ok(!f.element('tracking-action-message').textContent.startsWith('Copied'));
  }
  assert.equal(f.requests.length,0);
  assert.equal(f.confirmCount(),0);
  assert.equal(f.api.getRow('09812345675').lastUpdate,null);
});

test('raw aliases and invalid manual AWBs retain all history while grouping only the view', () => {
  const before = JSON.stringify(legacy);
  const saved = tracking.collectShipments([{awb:AWB,job:'DG-1'},{awb:AWB,job:'GC-2'}],[]).shipments;
  const rows = tracking.withManualHistory(saved,legacy);
  assert.equal(rows.length,2);
  const main = rows.find(row=>row.awb===AWB);
  assert.equal(main.manualEvents.length,2);
  assert.deepEqual(main.jobs.map(job=>job.job),['DG-1','GC-2']);
  assert.deepEqual(main.manualRecords.map(entry=>entry.key),['176-12345675','17612345675']);
  assert.equal(main.manualEvents[1].source,'Legacy imported entry');
  assert.equal(rows.find(row=>row.awb==='HOUSE-SAMPLE-01').manualStatus,'DEP');
  assert.equal(JSON.stringify(legacy),before);
});

test('import groups two jobs without synthesizing a third job or altering legacy aliases', () => {
  const log = [{awb:AWB,job:'DG-1'},{awb:AWB,job:'GC-2'}];
  const fresh = tracking.importSavedAwbs({},log,[]);
  assert.equal(fresh.added,1);
  const saved = tracking.collectShipments(log,[]).shipments;
  assert.deepEqual(tracking.withManualHistory(saved,fresh.all)[0].jobs.map(job=>job.job),['DG-1','GC-2']);
  const already = tracking.importSavedAwbs(legacy,log,[]);
  assert.equal(already.added,0);
  assert.deepEqual(already.all,legacy);
});

test('retained untrusted AWB values cannot inject markup or inline handlers', () => {
  const raw = '\"><img src=x onerror=evil()>12345678';
  const f = fixture(undefined,200,{jfs_tracking:{[raw]:{awb:raw,milestones:[]}}});
  const html = f.element('tracking-body').innerHTML;
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onclick='));
  f.api.renderDetail('manual:'+raw);
  assert.ok(!f.element('trk_detail').innerHTML.includes('<img'));
});

test('actual index manual update function preserves raw records and histories', () => {
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const section = html.slice(html.indexOf('const TRK_MILESTONES ='),html.indexOf('/* ---------- alt print'));
  const source = JSON.parse(JSON.stringify(legacy)), original = JSON.stringify(source);
  const storage = new Map([['jfs_tracking',original]]), note={value:'Entry note'}, pushes=[];
  const sandbox = {window:{DgTracking:tracking},DgTracking:tracking,Date,console,sbUser:null,
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    cloudPushDebounced:key=>pushes.push(key),store:()=>[],v:id=>id==='trk_ms'?'HLD':'Entry note',
    document:{getElementById:()=>note}};
  vm.runInNewContext(section,sandbox);
  sandbox.trackAddMs('HOUSE-SAMPLE-01');
  const after = JSON.parse(storage.get('jfs_tracking'));
  assert.deepEqual(after['176-12345675'],source['176-12345675']);
  assert.deepEqual(after['17612345675'],source['17612345675']);
  assert.deepEqual(after['HOUSE-SAMPLE-01'].milestones[0],source['HOUSE-SAMPLE-01'].milestones[0]);
  assert.equal(after['HOUSE-SAMPLE-01'].milestones[1].code,'HLD');
  assert.equal(after['HOUSE-SAMPLE-01'].milestones[1].src,'MANUAL');
  assert.deepEqual(pushes,['jfs_tracking']);
});

test('tracking cloud merge unions histories per raw key and keeps newer metadata without mutating either source', () => {
  const local = JSON.parse(JSON.stringify(legacy)), cloud = JSON.parse(JSON.stringify(legacy));
  cloud['176-12345675'].milestones.push({code:'RCS',ts:1700000030000,by:'Other staff'});
  cloud['176-12345675'].updated = 1700000030000;
  cloud['176-12345675'].route = 'DXB - JFK';
  local['176-12345675'].milestones.push({code:'HLD',ts:1700000040000,note:'Local unsynced note'});
  const before = JSON.stringify({local,cloud});
  const result = tracking.mergeManualStores(local,cloud);
  assert.equal(result['176-12345675'].milestones.length,3);
  assert.equal(result['176-12345675'].route,'DXB - JFK');
  assert.deepEqual(Object.keys(result).sort(),Object.keys(legacy).sort());
  assert.equal(JSON.stringify({local,cloud}),before);
  const strange = tracking.mergeManualStores({},JSON.parse('{"__proto__":{"awb":"__proto__","milestones":[]},"constructor":{"awb":"constructor","milestones":[]}}'));
  assert.equal(Object.getPrototypeOf(strange),null);
  assert.equal(strange.__proto__.awb,'__proto__');
  assert.equal(strange.constructor.awb,'constructor');
});

test('actual tracking cloud push merges latest company history and refuses a failed prerequisite read', async () => {
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const section = html.slice(html.indexOf('let _trackingPush ='),html.indexOf('function cloudPushDebounced'));
  let local = JSON.parse(JSON.stringify(legacy)), written, failRead = false, writes = 0;
  const cloud = JSON.parse(JSON.stringify(legacy));
  cloud['176-12345675'].milestones.push({code:'RCS',ts:1700000030000});
  const query = {eq:()=>query,maybeSingle:async()=>failRead ? {error:new Error('Read failed')} : {data:{value:cloud}}};
  const sandbox = {Promise,Date,Error,DgTracking:tracking,syncTimers:{},clearTimeout:()=>{},trackAll:()=>local,setSync:()=>{},sbUser:{id:'staff',email:'staff@example.test'},
    localStorage:{setItem:(key,value)=>{local=JSON.parse(value);},getItem:()=>JSON.stringify(local)},
    sb:{from:()=>({select:()=>query,upsert:async record=>{writes++;written=record;return {};}})}};
  vm.runInNewContext(section,sandbox);
  await sandbox.trackCloudPush();
  assert.equal(written.value['176-12345675'].milestones.length,2);
  assert.equal(local['176-12345675'].milestones.length,2);
  assert.deepEqual(local['HOUSE-SAMPLE-01'],legacy['HOUSE-SAMPLE-01']);
  failRead = true;
  await assert.rejects(sandbox.trackCloudPush(),/could not be read/);
  assert.equal(writes,1);
});

test('TrackCargo states distinguish not retrieved, not connected, not linked and pending without inventing milestones', () => {
  const rows = tracking.collectShipments([{awb:AWBS[0],job:'DG-1'}],[]).shipments;
  assert.equal(tracking.mergeTrackcargo(rows,[],false,false)[0].status,'Not retrieved');
  assert.equal(tracking.mergeTrackcargo(rows,[],true,false)[0].status,'TrackCargo not connected');
  assert.equal(tracking.mergeTrackcargo(rows,[],true,true)[0].status,'Not linked to TrackCargo');
  const payload = trackcargoPayload();
  const joined = tracking.mergeTrackcargo(rows,payload.shipments,true,true)[0];
  assert.equal(joined.status,'RCF');
  assert.equal(joined.arrivedAt,null);
  assert.equal(joined.deliveredAt,null);
  assert.equal(joined.plannedArrivalAt,'2026-09-28T00:05:00Z');
  assert.equal(tracking.filterShipments([joined],'DG-1','RCF').length,1);
  assert.equal(tracking.filterShipments([joined],'','DELIVERED').length,0);
  const pending = tracking.mergeTrackcargo(rows,[{...payload.shipments[1],awb:AWBS[0]}],true,true)[0];
  assert.equal(pending.status,'Awaiting carrier result');
  assert.equal(pending.lastUpdate,null);
});

test('CSV escapes formulas and uses only clearly labeled TrackCargo milestones and manual history', () => {
  for (const formula of ['=1+1',' +SUM(A1)','\t=1','\r@IMPORT','\ufeff-1','@SUM(1)']) assert.ok(tracking.csvCell(formula).startsWith('"\''));
  assert.equal(tracking.csvCell('a,"b"\nc'),'"a,""b""\nc"');
  const rows = tracking.mergeTrackcargo(tracking.withManualHistory(tracking.collectShipments([{awb:AWBS[0],job:'=HYPERLINK("bad")',shipper:'@attacker'}],[]).shipments,localSource().jfs_tracking),trackcargoPayload().shipments,true,true);
  const csv = tracking.toCsv(rows);
  assert.ok(csv.startsWith('\ufeff"AWB"'));
  assert.ok(csv.includes('"\'@attacker"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.match(csv,/TrackCargo/);
  assert.ok(!/CargoAi|subscription status/i.test(csv));
  for (const label of ['RCF','Planned','Actual','Manual note','Recorded:','LH7562S']) assert.ok(csv.includes(label),label);
  const manual = {'HOUSE-01':{awb:'HOUSE-01',route:'DXB - LHR',milestones:[]}};
  const manualCsv = tracking.toCsv(tracking.mergeTrackcargo(tracking.withManualHistory([],manual),[],false,false));
  assert.ok(manualCsv.includes('"DXB - LHR"'));
});

test('initialization, tabs, storage, visibility and refresh compatibility make no provider requests', async () => {
  const f = fixture(trackcargoPayload(),200,localSource());
  assert.equal(f.api.getRow(AWBS[0]).status,'Not retrieved');
  for (const name of ['track','rpt','dash','track']) f.api.onTab(name);
  await f.api.refresh();
  if (f.listeners['document:visibilitychange']) f.listeners['document:visibilitychange']();
  if (f.listeners['window:storage']) f.listeners['window:storage']({key:'jfs_tracking'});
  for (const tick of f.intervals) tick();
  await new Promise(setImmediate);
  assert.equal(f.requests.length,0);
  assert.equal(f.intervals.length,0,'No tracking poll timer should remain');
  assert.equal(f.listeners['tracking-sync:click'],undefined);
  assert.equal(f.confirmCount(),0);
});

test('one explicit refresh powers main rows, KPIs and reports without old CargoAi fallback or changing saved records', async () => {
  const source = localSource(), before = JSON.stringify(source), f = fixture(trackcargoPayload(),200,source);
  assert.equal(f.element('tracking-total').textContent,5);
  await f.listeners['tracking-refresh:click']();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,TRACKCARGO_ENDPOINT);
  assert.equal(f.requests[0].init.method,'GET');
  assert.equal(f.requests[0].init.headers.Authorization,'Bearer fixture-only');
  assert.equal(f.element('tracking-total').textContent,5);
  assert.equal(f.element('tracking-updates').textContent,1);
  assert.equal(f.element('tracking-pending').textContent,2);
  assert.equal(f.element('tracking-unlinked').textContent,2);
  const html = f.element('tracking-body').innerHTML;
  assert.equal((html.match(/data-tracking-action="airline"/g)||[]).length,5);
  assert.equal((html.match(/Awaiting carrier result/g)||[]).length,2);
  assert.equal((html.match(/Not linked to TrackCargo/g)||[]).length,2);
  assert.match(html,/RCF/);
  assert.match(html,/24 Sept? 2026, 22:03 UTC/);
  assert.match(html,/<time datetime="2026-09-27T01:00:00\.000Z" aria-label="Last checked 27 Sept? 2026, 01:00 UTC">/);
  assert.ok(!/CargoAi|CargoCONNECT|Start tracking|saved status/i.test(view(f)));
  assert.equal(f.api.reportInfo(AWBS[0]).status,'RCF');
  assert.match(f.api.reportCells(AWBS[0],''),/TrackCargo/);
  assert.ok(!/CargoAi/i.test(f.api.reportCells(AWBS[0],'')));
  assert.equal(f.api.reportInfo(AWBS[3]).status,'Not linked to TrackCargo');
  assert.equal(f.api.getRow(AWBS[3]).lastUpdate,null);
  assert.equal(JSON.stringify(source),before);
  assert.ok(f.reportRenders.length>0,'Dashboard/document report cache should repaint after explicit refresh');
});

test('CargoAi-shaped results cannot become TrackCargo results through the new UI', async () => {
  const payload = trackcargoPayload();
  payload.shipments = [{awb:AWBS[0],provider:'cargoai',status:'DELIVERED',lastUpdate:'2026-09-26T10:00:00Z',deliveredAt:'2026-09-26T09:00:00Z'}];
  const f = fixture(payload,200,localSource());
  await f.api.refreshTrackcargo();
  assert.equal(f.api.getRow(AWBS[0]).status,'Not linked to TrackCargo');
  assert.equal(f.api.getRow(AWBS[0]).deliveredAt,null);
  assert.ok(!f.element('tracking-body').innerHTML.includes('DELIVERED'));
  assert.equal(f.element('tracking-updates').textContent,0);
});

test('Export CSV uses the current filtered TrackCargo rows and creates no tracking requests', async () => {
  const f=fixture(trackcargoPayload(),200,localSource());
  await f.api.refreshTrackcargo();
  const blobs=[], links=[];
  f.sandbox.URL={createObjectURL:blob=>{blobs.push(blob);return 'blob:test-export';},revokeObjectURL:()=>{}};
  f.sandbox.document.createElement=()=>({click(){links.push(this);},remove(){}});
  f.sandbox.document.body={appendChild:()=>{}};
  f.element('tracking-search').value='020-12345675';
  f.listeners['tracking-search:input']();
  f.listeners['tracking-export:click']();
  assert.equal(blobs.length,1); assert.equal(links.length,1);
  assert.match(links[0].download,/^DGDOC_Shipment_Tracking_.*\.csv$/);
  const csv=await blobs[0].text();
  assert.match(csv,/020-12345675/); assert.match(csv,/RCF/); assert.match(csv,/TrackCargo/);
  assert.ok(!/098-12345675|CargoAi/.test(csv));
  assert.equal(f.requests.length,1,'Export must use existing retrieved data');
});

test('manual DLV and latest partial delivery events do not turn into whole-shipment delivery KPIs or verified dates', async () => {
  const f = fixture({configured:true,mode:'read_only',shipments:[]},200,{jfs_tracking:legacy});
  await f.api.refreshTrackcargo();
  assert.equal(f.api.reportInfo(AWB).status,'Not linked to TrackCargo');
  assert.equal(f.api.reportInfo(AWB).manualStatus,'DLV');
  assert.equal(f.api.getRow(AWB).deliveredAt,null);
  assert.equal(f.element('tracking-updates').textContent,0);
  assert.equal(f.api.reportInfo('HOUSE-SAMPLE-01').manualStatus,'DEP');
  const payload = trackcargoPayload();
  payload.shipments = [{...payload.shipments[0],awb:AWB,status:'DLV',statusDescription:'Partial shipment delivered',deliveredAt:null}];
  f.setResponse(payload);
  await f.api.refreshTrackcargo();
  assert.equal(f.element('tracking-updates').textContent,1);
  assert.equal(f.api.getRow(AWB).deliveredAt,null);
  f.api.renderDetail(AWB);
  assert.match(f.element('trk_detail').innerHTML,/<dt>Verified delivery<\/dt><dd>—<\/dd>/);
});

test('main row separates carrier, retrieval and manual recorded times without promoting legacy notes into manual or carrier progress', async () => {
  const source=localSource(), recorded=Date.parse('2026-09-25T14:30:00Z');
  source.jfs_tracking['020-12345675'].milestones=[
    {code:'BKD',src:'MANUAL',ts:Date.parse('2026-09-21T09:00:00Z'),note:'Older operator note'},
    {code:'DLV',src:'MANUAL',ts:recorded,note:'<img src=x onerror=alert(1)> operator note'},
    {code:'DEP',src:'CARGO CONNECT',ts:Date.parse('2026-09-26T16:45:00Z'),note:'Later legacy imported carrier entry'}
  ];
  source.jfs_tracking['147-12345675']={awb:'147-12345675',milestones:[{code:'DLV',src:'MANUAL',ts:recorded,note:'Manual-only report'}]};
  const before=JSON.stringify(source), f=fixture(trackcargoPayload(),200,source);
  await f.ready; await f.api.refreshTrackcargo();
  const html=f.element('tracking-body').innerHTML;
  const row=html.match(/<tr data-awb="02012345675"[^>]*>([\s\S]*?)<\/tr>/)[1];
  assert.match(row,/TrackCargo<\/span><span[^>]*>RCF<\/span>/);
  assert.match(row,/Manual update<\/span><span[^>]*>DLV<\/span>/);
  assert.match(row,/<time datetime="2026-09-24T22:03:00\.000Z" aria-label="Carrier event 24 Sept? 2026, 22:03 UTC">/);
  assert.match(row,/<time datetime="2026-09-27T01:00:00\.000Z" aria-label="Last checked 27 Sept? 2026, 01:00 UTC">/);
  assert.match(row,/<time datetime="2026-09-25T14:30:00\.000Z" aria-label="Manual entry recorded 25 Sept? 2026, 14:30 UTC">/);
  assert.ok(!row.includes('Later legacy imported carrier entry'));
  assert.ok(!row.includes('Older operator note'));
  assert.ok(!row.includes('<img'));
  assert.ok(row.includes('&lt;img src=x onerror=alert(1)&gt; operator note'));
  const unlinked=html.match(/<tr data-awb="14712345675"[^>]*>([\s\S]*?)<\/tr>/)[1];
  assert.match(unlinked,/Not linked to TrackCargo/); assert.match(unlinked,/Manual update/);
  assert.match(unlinked,/No carrier event yet/); assert.ok(!unlinked.includes('aria-label="Carrier event '));
  assert.equal(f.api.getRow(AWBS[0]).status,'RCF');
  assert.equal(f.api.getRow(AWBS[3]).lastUpdate,null);
  assert.equal(f.element('tracking-updates').textContent,1);
  f.api.renderDetail(AWBS[0]); assert.match(f.element('trk_detail').innerHTML,/Later legacy imported carrier entry/);
  assert.equal(JSON.stringify(source),before);
  assert.equal(f.requests.length,1);
});

test('manual airline links and legacy sync compatibility never initiate tracking or alter stored data', async () => {
  const source = localSource(), before = JSON.stringify(source), f = fixture(trackcargoPayload(),200,source);
  for (const awb of AWBS) {
    await clickTrackingAction(f,'airline',awb);
    f.api.renderDetail(awb);
    assert.ok(!/data-detail-action="auto"|CargoAi|CargoCONNECT/.test(f.element('trk_detail').innerHTML));
    if (f.api.sync) await f.api.sync(awb);
  }
  if (f.api.sync) await f.api.sync();
  assert.equal(f.requests.length,0);
  assert.equal(f.confirmCount(),0);
  assert.equal(JSON.stringify(source),before);
});

test('TrackCargo details label actual and planned events, escape provider text and preserve unsaved manual notes', async () => {
  const payload = trackcargoPayload();
  payload.shipments[0].events[0].description = '<img src=x onerror=alert(1)>';
  payload.shipments[0].orderId = '<script>order</script>';
  const f = fixture(payload,200,localSource());
  f.api.renderDetail(AWBS[0]);
  f.element('trk_note').value='Unsaved note'; f.element('trk_ms').value='DEP';
  f.element('trk_detail').querySelectorAll=()=>['manual','trackcargo'].map(detailSection=>({dataset:{detailSection}}));
  await f.api.refreshTrackcargo();
  const detail=f.element('trk_detail').innerHTML;
  assert.match(detail,/data-detail-section="trackcargo" open/);
  assert.match(detail,/Origin departure event/);
  assert.match(detail,/<dt>Verified arrival<\/dt><dd>—<\/dd>/);
  assert.match(detail,/<dt>Verified delivery<\/dt><dd>—<\/dd>/);
  assert.match(detail,/<dt>Planned arrival<\/dt><dd>28 Sept? 2026, 00:05 UTC<\/dd>/);
  assert.match(detail,/Actual · TrackCargo/); assert.match(detail,/Planned · TrackCargo/);
  assert.match(detail,/Event location timezone: Europe\/Vienna/);
  assert.match(detail,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!detail.includes('<img src=x')); assert.ok(!detail.includes('&lt;script&gt;order&lt;/script&gt;'));
  assert.ok(!/CargoAi|CargoCONNECT|Automatic tracking/.test(detail));
  assert.equal(f.element('trk_note').value,'Unsaved note'); assert.equal(f.element('trk_ms').value,'DEP');
  await clickTrackingAction(f,'timeline',AWBS[3]);
  assert.match(f.element('trk_detail').innerHTML,/No existing TrackCargo order was returned for this AWB/);
  assert.equal(f.requests.length,1);
});

test('explicit detail navigation moves focus once and local render preserves expanded jobs and sections', async () => {
  const source = localSource(); source.jfs_joblog.push({awb:AWBS[0],job:'OTHER-JOB'});
  const f = fixture(trackcargoPayload(),200,source), navigation=[];
  f.element('tracking-detail-title').focus=options=>navigation.push({action:'heading-focus',...options});
  f.element('trk_detail').scrollIntoView=options=>navigation.push({action:'detail-scroll',...options});
  const rowButton={closest:()=>({dataset:{awb:AWBS[0]}}),focus:()=>navigation.push({action:'row-focus'})};
  f.element('tracking-body').querySelectorAll=selector=>selector==='[data-tracking-action="timeline"]'?[rowButton]:[{dataset:{jobGroup:AWBS[0]}}];
  await clickTrackingAction(f,'timeline',AWBS[0]);
  assert.equal(navigation.length,2);
  f.element('trk_detail').querySelectorAll=()=>['manual','trackcargo'].map(detailSection=>({dataset:{detailSection}}));
  f.element('trk_note').value='Not yet saved';
  await f.api.refresh(); f.api.onTab('track');
  assert.equal(navigation.length,2);
  assert.match(f.element('tracking-body').innerHTML,/<details class="tracking-more-jobs" data-job-group="02012345675" open>/);
  assert.match(f.element('trk_detail').innerHTML,/data-detail-section="manual" open/);
  assert.equal(f.element('trk_note').value,'Not yet saved');
  f.listeners['trk_detail:click']({target:{closest:()=>({dataset:{detailAction:'close'}})}});
  assert.equal(navigation.at(-1).action,'row-focus'); assert.equal(f.element('trk_detail').innerHTML,'');
  assert.equal(f.requests.length,0);
});

test('partial and network failures retain prior results marked stale in table, details, reports and CSV', async () => {
  const f=fixture(trackcargoPayload(),200,localSource());
  await f.api.refreshTrackcargo();
  const partial=trackcargoPayload();
  partial.shipments[0]={awb:AWBS[0],provider:'trackcargo',dataStatus:'ERROR',status:'UNKNOWN',message:'Carrier lookup unavailable',fetchedAt:'2026-09-27T02:00:00Z'};
  f.setResponse(partial); await f.api.refreshTrackcargo();
  let html=f.element('tracking-body').innerHTML;
  assert.match(html,/Not refreshed/); assert.match(html,/RCF/);
  assert.match(html,/<time datetime="2026-09-27T01:00:00\.000Z" aria-label="Last checked 27 Sept? 2026, 01:00 UTC">/);
  assert.ok(!html.includes('aria-label="Last checked 27 Sept 2026, 02:00 UTC"'));
  assert.match(f.api.reportCells(AWBS[0],''),/Not refreshed/i);
  assert.match(f.api.toCsv([f.api.getRow(AWBS[0])]),/Carrier lookup unavailable|Not refreshed/i);
  f.setResponse(null,502); await f.api.refreshTrackcargo();
  assert.match(view(f),/TrackCargo could not be refreshed/); assert.match(f.element('tracking-body').innerHTML,/RCF/);
  f.api.renderDetail(AWBS[0]); assert.match(f.element('trk_detail').innerHTML,/last retrieved|Not refreshed|could not be refreshed/);
  const pending=trackcargoPayload(); pending.shipments[0]={...pending.shipments[1],awb:AWBS[0],orderId:'existing-lh'};
  f.setResponse(pending); await f.api.refreshTrackcargo();
  html=f.element('tracking-body').innerHTML;
  assert.ok(!html.includes('RCF')); assert.ok(!html.includes('Not refreshed'));
  assert.equal(f.element('tracking-pending').textContent,3);
  assert.equal(f.api.getRow(AWBS[0]).lastUpdate,null);
});

test('logout clears results and late responses cannot overwrite or unlock a new account request', async () => {
  const f=fixture(trackcargoPayload(),200,localSource()); await f.api.refreshTrackcargo();
  const pending=[]; f.sandbox.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const oldRequest=f.api.refreshTrackcargo(); await new Promise(setImmediate);
  f.authListener()('SIGNED_OUT',null);
  assert.ok(!view(f).includes('RCF')); assert.equal(f.api.reportInfo(AWBS[0]).status,'Not retrieved');
  f.auth.user.id='next-user'; f.authListener()('SIGNED_IN',f.auth);
  const newRequest=f.api.refreshTrackcargo(); await new Promise(setImmediate);
  pending[0]({ok:true,status:200,json:async()=>trackcargoPayload()}); await oldRequest;
  assert.equal(f.element('tracking-refresh').disabled,true); assert.ok(!view(f).includes('RCF'));
  await f.api.refreshTrackcargo(); assert.equal(pending.length,2);
  const next=trackcargoPayload(); next.shipments=next.shipments.slice(1);
  pending[1]({ok:true,status:200,json:async()=>next}); await newRequest;
  assert.equal(f.element('tracking-refresh').disabled,false); assert.ok(!view(f).includes('RCF'));
  assert.equal(f.api.reportInfo(AWBS[0]).status,'Not linked to TrackCargo');
});

test('missing setup, rejected contracts and access denial show honest errors without CargoAi fallbacks', async () => {
  const f=fixture(undefined,200,localSource());
  f.setResponse({configured:false,mode:'read_only',shipments:[],message:'TrackCargo is not configured.'},503);
  await f.api.refreshTrackcargo(); assert.match(view(f),/TrackCargo is not configured/);
  assert.equal(f.api.getRow(AWBS[0]).status,'TrackCargo not connected');
  f.setResponse({...trackcargoPayload(),mode:'automatic'}); await f.api.refreshTrackcargo();
  assert.match(view(f),/unexpected response/); assert.ok(!view(f).includes('RCF'));
  f.setResponse(trackcargoPayload()); await f.api.refreshTrackcargo();
  f.setResponse({error:'denied'},403); await f.api.refreshTrackcargo();
  assert.match(view(f),/Your account cannot access TrackCargo/); assert.ok(!view(f).includes('RCF'));
  assert.ok(f.requests.every(request=>request.url===TRACKCARGO_ENDPOINT && request.init.method==='GET'));
});

test('an expired local session clears TrackCargo data before making any further request', async () => {
  const f=fixture(trackcargoPayload(),200,localSource());
  await f.api.refreshTrackcargo();
  f.auth.access_token=null;
  await f.api.refreshTrackcargo();
  assert.equal(f.requests.length,1);
  assert.match(view(f),/Sign in to view TrackCargo orders/);
  assert.ok(!view(f).includes('RCF'));
  assert.equal(f.api.reportInfo(AWBS[0]).status,'Not retrieved');
  assert.equal(f.element('tracking-refresh').disabled,false);
});

test('page and document exports present TrackCargo only and retain a single tracking host', () => {
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.equal((html.match(/id="tab-track"/g)||[]).length,1);
  assert.equal((html.match(/id="nav-track"/g)||[]).length,1);
  const page=html.slice(html.indexOf('id="tab-track"'),html.indexOf('id="trk_detail"')+1000);
  assert.ok(!/CargoAi|CargoCONNECT|tracking-sync|tracking-automatic|trackcargo-panel/.test(page));
  assert.ok(!html.includes('id="cc_key"')); assert.ok(!html.includes('function trackCCConfig'));
  assert.ok(!html.includes('function trackCCFetch')); assert.ok(!html.includes('function trackCCUpdateAll'));
  assert.ok(!html.includes('CARGOAI STATUS')); assert.ok(!html.includes('LAST CARGOAI UPDATE'));
  assert.ok(html.includes('TRACKCARGO'));
  const js=fs.readFileSync(path.join(__dirname,'../tracking.js'),'utf8');
  assert.ok(!js.includes('/.netlify/functions/cargoai-tracking'));
  assert.ok(!/method\s*:\s*['"]POST['"]/.test(js));
});

async function savedSnapshot(config = {}) {
  const f=fixture(trackcargoPayload(),200,localSource(),config);
  await f.ready;
  await f.api.refreshTrackcargo();
  const key=SNAPSHOT_PREFIX+f.auth.user.id;
  assert.ok(f.storage.has(key),'An explicit successful refresh must save a browser snapshot');
  return {f,key,envelope:JSON.parse(f.storage.get(key))};
}

test('same-account reload and new tabs restore timestamped saved results without requesting the provider', async () => {
  const {f,key,envelope}=await savedSnapshot();
  for(let i=0;i<2;i++) {
    const next=fixture(undefined,200,localSource(),{storage:f.storage});
    assert.equal(next.api.getRow(AWBS[0]).status,'Not retrieved','No data should render before the async session gate');
    await next.ready;
    assert.equal(next.api.getRow(AWBS[0]).status,'RCF');
    assert.equal(next.element('tracking-pending').textContent,2);
    assert.equal(next.element('tracking-unlinked').textContent,2);
    assert.match(view(next),/saved snapshot/i);
    assert.match(view(next),/24 Sept? 2026, 22:03 UTC/);
    assert.match(next.element('tracking-checked').textContent,new RegExp(tracking.dateText(envelope.checkedAt).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(next.requests.length,0);
    assert.equal(JSON.parse(next.storage.get(key)).checkedAt,envelope.checkedAt,'Opening a page must not advance retrieval time');
  }
});

test('snapshot serialization whitelists normalized data and excludes credentials, order IDs and raw payloads', async () => {
  const payload=trackcargoPayload();
  payload.shipments[0].apiKey='secret-sentinel';
  payload.shipments[0].rawResponse={access_token:'raw-token-sentinel',parties:['private-party-sentinel']};
  payload.shipments[0].events[0].debugToken='event-secret-sentinel';
  const f=fixture(payload,200,localSource()); await f.ready; await f.api.refreshTrackcargo();
  const serialized=f.storage.get(SNAPSHOT_PREFIX+f.auth.user.id), data=JSON.parse(serialized);
  assert.equal(data.version,1); assert.equal(data.userId,f.auth.user.id); assert.equal(data.configured,true);
  assert.equal(data.shipments.length,3);
  assert.equal(data.shipments[0].awb,AWBS[0]); assert.equal(data.shipments[0].events[0].isPlanned,false);
  for(const forbidden of ['fixture-only','existing-lh','secret-sentinel','raw-token-sentinel','private-party-sentinel','event-secret-sentinel','apiKey','rawResponse','orderId','access_token']) assert.ok(!serialized.includes(forbidden),forbidden);
});

test('snapshots never restore for a missing, expired or different authenticated session', async () => {
  const {f}=await savedSnapshot();
  for(const auth of [null,{user:{id:'fixture-user'}},{access_token:'expired',user:{id:'fixture-user'},expires_at:Math.floor(Date.now()/1000)-1},{access_token:'other',user:{id:'other-user'},expires_at:Math.floor(Date.now()/1000)+3600}]) {
    const next=fixture(undefined,200,localSource(),{storage:new Map(f.storage),auth});
    await next.ready;
    assert.ok(!view(next).includes('RCF'));
    assert.equal(next.requests.length,0);
  }
});

test('corrupt, mismatched and oversized snapshot envelopes are ignored before rendering', async () => {
  const {key,envelope}=await savedSnapshot();
  const clone=()=>JSON.parse(JSON.stringify(envelope));
  const wrongVersion=clone(); wrongVersion.version=2;
  const wrongUser=clone(); wrongUser.userId='someone-else';
  const wrongDate=clone(); wrongDate.checkedAt='not-a-date';
  const duplicate=clone(); duplicate.shipments.push(duplicate.shipments[0]);
  const nonCanonical=clone(); nonCanonical.shipments[0].awb='020-12345675';
  const tooMany=clone(); tooMany.shipments=Array.from({length:6},()=>tooMany.shipments[0]);
  const tooManyEvents=clone(); tooManyEvents.shipments[0].events=Array.from({length:2001},()=>tooManyEvents.shipments[0].events[0]);
  const invalidEvent=clone(); invalidEvent.shipments[0].events[0].isPlanned='false';
  const invalidProvider=clone(); invalidProvider.shipments[0].provider='cargoai';
  const cases=['{broken',JSON.stringify(wrongVersion),JSON.stringify(wrongUser),JSON.stringify(wrongDate),JSON.stringify(duplicate),JSON.stringify(nonCanonical),JSON.stringify(tooMany),JSON.stringify(tooManyEvents),JSON.stringify(invalidEvent),JSON.stringify(invalidProvider),'x'.repeat(2*1024*1024+1)];
  for(const [index,serialized] of cases.entries()) {
    const next=fixture(undefined,200,localSource(),{storage:new Map([[key,serialized]])});
    await next.ready;
    assert.ok(!view(next).includes('RCF'),'Invalid cache case '+index+' must not present current carrier status');
    assert.equal(next.requests.length,0);
  }
});

test('local storage denial or quota failure keeps current retrieved results usable and reports unsaved snapshots', async () => {
  const controls={read:true,write:true};
  const f=fixture(trackcargoPayload(),200,localSource(),{storageControl:controls});
  await f.ready;
  await f.api.refreshTrackcargo();
  assert.equal(f.api.getRow(AWBS[0]).status,'RCF');
  assert.match(view(f),/could not be saved/i);
  assert.equal(f.requests.length,1);
  assert.equal(f.element('tracking-refresh').disabled,false);
  controls.remove=true;
  assert.doesNotThrow(()=>f.authListener()('SIGNED_OUT',null));
  assert.ok(!view(f).includes('RCF'));
});

test('logout, account change and authorization or setup failures remove only this feature scoped snapshot', async () => {
  for(const cause of ['logout','account-change',401,403,503]) {
    const {f,key}=await savedSnapshot();
    f.storage.set('unrelated-job-data','must-stay');
    if(cause==='logout') f.authListener()('SIGNED_OUT',null);
    else if(cause==='account-change') f.authListener()('SIGNED_IN',{access_token:'different',user:{id:'different-user'}});
    else {
      f.setResponse(cause===503?{configured:false,mode:'read_only',shipments:[],message:'TrackCargo is not configured.'}:{error:'denied'},cause);
      await f.api.refreshTrackcargo();
    }
    await new Promise(setImmediate);
    assert.equal(f.storage.has(key),false,String(cause));
    assert.equal(f.storage.get('unrelated-job-data'),'must-stay');
    assert.ok(!view(f).includes('RCF'),String(cause));
  }
});

test('cross-tab snapshots update the same account without fetches and older or unrelated snapshots cannot replace them', async () => {
  const {f,key,envelope}=await savedSnapshot();
  const old=JSON.parse(JSON.stringify(envelope)); old.checkedAt=new Date(Date.now()-10000).toISOString();
  f.storage.set(key,JSON.stringify(old));
  const next=fixture(undefined,200,localSource(),{storage:f.storage}); await next.ready;
  const newer=JSON.parse(JSON.stringify(envelope)); newer.checkedAt=new Date().toISOString(); newer.shipments[0].status='RCS'; newer.shipments[0].statusDescription='Newer saved carrier event';
  const serialized=JSON.stringify(newer);
  f.storage.set(key,serialized);
  await next.listeners['window:storage']({key,newValue:serialized,storageArea:next.sandbox.localStorage});
  await new Promise(setImmediate);
  assert.equal(next.api.getRow(AWBS[0]).status,'RCS');
  assert.match(view(next),/saved snapshot/i); assert.equal(next.requests.length,0);
  f.storage.set(key,JSON.stringify(old));
  await next.listeners['window:storage']({key,newValue:JSON.stringify(old),storageArea:next.sandbox.localStorage});
  await next.listeners['window:storage']({key:SNAPSHOT_PREFIX+'other-user',newValue:JSON.stringify(old),storageArea:next.sandbox.localStorage});
  await new Promise(setImmediate);
  assert.equal(next.api.getRow(AWBS[0]).status,'RCS');
  assert.equal(next.requests.length,0);
  f.storage.delete(key);
  await next.listeners['window:storage']({key,newValue:null,storageArea:next.sandbox.localStorage});
  await new Promise(setImmediate);
  assert.ok(!view(next).includes('RCS'));
});

test('stored refresh errors remain visible after reload while a later successful result replaces the saved snapshot', async () => {
  const {f,key}=await savedSnapshot();
  f.setResponse(null,502); await f.api.refreshTrackcargo();
  const next=fixture(trackcargoPayload(),200,localSource(),{storage:f.storage}); await next.ready;
  assert.equal(next.api.getRow(AWBS[0]).status,'RCF');
  assert.match(view(next),/could not be refreshed|Not refreshed/);
  assert.match(next.api.reportCells(AWBS[0],''),/Not refreshed/);
  assert.equal(next.requests.length,0);
  await next.api.refreshTrackcargo();
  assert.ok(!/could not be refreshed|Not refreshed/.test(view(next)));
  assert.equal(JSON.parse(next.storage.get(key)).error,'');
});

test('late startup restoration cannot overwrite an explicit refresh or resurrect data after logout', async () => {
  const {f}=await savedSnapshot();
  let resolveSession, calls=0;
  const auth={access_token:'fixture-only',user:{id:'fixture-user'}};
  const next=fixture(trackcargoPayload(),200,localSource(),{storage:new Map(f.storage),getSession:()=>++calls===1?new Promise(resolve=>{resolveSession=resolve;}):Promise.resolve({data:{session:auth}})});
  const fresh=trackcargoPayload(); fresh.shipments[0].status='RCS'; next.setResponse(fresh);
  await next.api.refreshTrackcargo();
  resolveSession({data:{session:auth}}); await next.ready;
  assert.equal(next.api.getRow(AWBS[0]).status,'RCS');
  assert.equal(next.requests.length,1);
  let resolveLoggedOut;
  const loggedOut=fixture(undefined,200,localSource(),{storage:new Map(f.storage),getSession:()=>new Promise(resolve=>{resolveLoggedOut=resolve;})});
  loggedOut.authListener()('SIGNED_OUT',null);
  resolveLoggedOut({data:{session:auth}}); await loggedOut.ready;
  assert.ok(!view(loggedOut).includes('RCF'));
  assert.equal(loggedOut.requests.length,0);
});

test('auth callbacks restore from supplied sessions without reentering getSession', async () => {
  const {f}=await savedSnapshot();
  let getSessionCalls=0;
  const next=fixture(undefined,200,localSource(),{storage:new Map(f.storage),getSession:async()=>{getSessionCalls++;return {data:{session:null}};}});
  await next.ready;
  const baseline=getSessionCalls;
  next.authListener()('SIGNED_IN',{access_token:'fixture-only',user:{id:'fixture-user'}});
  await new Promise(setImmediate);
  assert.equal(getSessionCalls,baseline,'Auth callback must not reenter the Supabase auth lock');
  assert.equal(next.api.getRow(AWBS[0]).status,'RCF');
  assert.equal(next.requests.length,0);
});

test('a new account auth event wins over an older session lookup that started before identity was known', async () => {
  const {f,envelope}=await savedSnapshot();
  const second=JSON.parse(JSON.stringify(envelope));
  second.userId='next-user'; second.shipments[0].status='RCS';
  const storage=new Map(f.storage), key=SNAPSHOT_PREFIX+second.userId;
  storage.set(key,JSON.stringify(second));
  let resolveInitial;
  const next=fixture(undefined,200,localSource(),{storage,getSession:()=>new Promise(resolve=>{resolveInitial=resolve;})});
  next.authListener()('SIGNED_IN',{access_token:'next-account-token',user:{id:'next-user'}});
  await new Promise(setImmediate);
  assert.equal(next.api.getRow(AWBS[0]).status,'RCS');
  resolveInitial({data:{session:f.auth}}); await next.ready;
  assert.equal(next.api.getRow(AWBS[0]).status,'RCS','Stale startup identity must not replace the authenticated account');
  assert.equal(storage.has(key),true,'Stale startup identity must not purge the new account snapshot');
  assert.equal(next.requests.length,0);
});

test('cross-tab snapshot removal invalidates an outstanding response and cannot repopulate cleared results', async () => {
  const {f,key}=await savedSnapshot();
  let resolveResponse;
  f.sandbox.fetch=()=>new Promise(resolve=>{resolveResponse=resolve;});
  const request=f.api.refreshTrackcargo(); await new Promise(setImmediate);
  f.storage.delete(key);
  f.listeners['window:storage']({key,newValue:null,storageArea:f.sandbox.localStorage});
  resolveResponse({ok:true,status:200,json:async()=>trackcargoPayload()}); await request;
  assert.ok(!view(f).includes('RCF'));
  assert.equal(f.storage.has(key),false);
  assert.equal(f.element('tracking-refresh').disabled,false);
});

test('actual adapter output with string quantities saves and restores without changing quantity types', async () => {
  const {normalizeTrackCargoShipment}=await import('../netlify/functions/_lib/trackcargo.mjs');
  const orderId='2a2da1ac-8647-4d5e-bfe6-6a3cdf0b8edc';
  const envelope=data=>({success:true,error:null,data});
  const quantities=[[7,2721.5],[0,1e-7],[1e12,1e12],[null,null]];
  const events=quantities.map(([pieces,weight],index)=>({
    carrier_event_code:'RCF',carrier_event_description:'Synthetic adapter quantity sample',location:'VIE',
    date_utc_iso:{date:'2026-09-24T22:0'+index+':00.000Z'},elapsed:true,pieces,weight,weight_unit:'kg',timezone:'Europe/Vienna'
  }));
  const normalized=normalizeTrackCargoShipment({awb:'020-12345675',orderId,now:new Date('2026-09-27T01:00:00Z'),
    order:envelope({orderId,trackingId:AWBS[0],trackingType:'air',deleted:false,status:'active'}),
    tracking:envelope({status:'AVAILABLE',trackingData:{tracking_id:AWBS[0],awb:{prefix:'020',number:'12345675'},origin_airport_code:'DWC',destination_airport_code:'JFK',events}})
  });
  assert.deepEqual(normalized.events.map(event=>[event.pieces,event.weight]),[['7','2721.5'],['0','1e-7'],['1000000000000','1000000000000'],[null,null]]);
  const f=fixture({configured:true,mode:'read_only',shipments:[normalized]},200,localSource());
  await f.ready; await f.api.refreshTrackcargo();
  assert.ok(!view(f).includes('could not be saved'));
  const key=SNAPSHOT_PREFIX+f.auth.user.id, saved=JSON.parse(f.storage.get(key));
  assert.equal(saved.shipments[0].awb,AWBS[0]);
  assert.deepEqual(saved.shipments[0].events.map(event=>[event.pieces,event.weight]),normalized.events.map(event=>[event.pieces,event.weight]));
  const next=fixture(undefined,200,localSource(),{storage:f.storage}); await next.ready;
  assert.equal(next.api.getRow(AWBS[0]).status,'RCF');
  assert.deepEqual(Array.from(next.api.getRow(AWBS[0]).events,event=>[event.pieces,event.weight]),normalized.events.map(event=>[event.pieces,event.weight]));
  assert.equal(next.requests.length,0);
  next.api.renderDetail(AWBS[0]);
  assert.match(view(next),/7 pieces/); assert.match(view(next),/2721\.5 kg/);
});

test('snapshot quantities reject noncanonical strings, invalid types and bounds while numeric values remain compatible', async () => {
  const {key,envelope}=await savedSnapshot();
  const invalid={pieces:[-1,0.5,1e12+1,'-1','0.5','1e-7','1000000000001','', ' 7','7 ','07','+7','7.0','7e0','NaN','Infinity',true,{},[]],
    weight:[-1,1e12+1,'-1','1000000000001','', ' 7','7 ','07','+7','7.0','7e0','NaN','Infinity',false,{},[]]};
  for(const [field,values] of Object.entries(invalid)) for(const value of values) {
    const changed=JSON.parse(JSON.stringify(envelope)); changed.shipments[0].events[0][field]=value;
    const f=fixture(undefined,200,localSource(),{storage:new Map([[key,JSON.stringify(changed)]])}); await f.ready;
    assert.ok(!view(f).includes('RCF'),'Reject '+field+'='+JSON.stringify(value));
    assert.equal(f.requests.length,0);
  }
  const numeric=JSON.parse(JSON.stringify(envelope)); numeric.shipments[0].events[0].pieces=7; numeric.shipments[0].events[0].weight=2721.5;
  const compatible=fixture(undefined,200,localSource(),{storage:new Map([[key,JSON.stringify(numeric)]])}); await compatible.ready;
  assert.equal(compatible.api.getRow(AWBS[0]).events[0].pieces,7);
  assert.equal(compatible.api.getRow(AWBS[0]).events[0].weight,2721.5);
});
