const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tracking = require('../tracking.js');
const AWB = '17612345675';

test('MAWB validation accepts formatting, rejects house AWBs, bad check digits and missing digits', () => {
  assert.equal(tracking.normalizeAwb(' 176-1234 5675 '), AWB);
  for (const value of ['HAWB-12345675', '17612345674', '1761234567', '176123456755', '<script>17612345675']) assert.equal(tracking.normalizeAwb(value), '');
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

test('tracking state never invents milestone dates or overwrites document status', () => {
  const rows = tracking.collectShipments([{awb:AWB,job:'DG-1'}],[]).shipments;
  const disconnected = tracking.mergeTracking(rows,[],false)[0];
  assert.equal(disconnected.status, 'Tracking not connected');
  assert.equal(disconnected.deliveredAt, null);
  const joined = tracking.mergeTracking(rows,[{awb:'176-12345675',status:'IN_TRANSIT',lastUpdate:'2026-09-26T10:00:00Z'}],true)[0];
  assert.equal(joined.status,'IN TRANSIT');
  assert.equal(joined.arrivedAt,null);
  assert.equal(tracking.filterShipments([joined],'DG-1','IN TRANSIT').length,1);
  assert.equal(tracking.filterShipments([joined],'','DELIVERED').length,0);
});

test('CSV quotes delimiters, line breaks and neutralizes spreadsheet formulas', () => {
  for (const formula of ['=1+1',' +SUM(A1)','\t=1','\r@IMPORT','\ufeff-1','@SUM(1)']) assert.ok(tracking.csvCell(formula).startsWith('"\''));
  assert.equal(tracking.csvCell('a,"b"\nc'), '"a,""b""\nc"');
  const rows = tracking.mergeTracking(tracking.collectShipments([{awb:AWB,job:'=HYPERLINK("bad")',shipper:'@attacker'}],[]).shipments,[],false);
  const csv = tracking.toCsv(rows);
  assert.ok(csv.startsWith('\ufeff"AWB"'));
  assert.ok(csv.includes('"\'@attacker"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
});

test('UNKNOWN placeholders distinguish pending first updates from unsubscribed AWBs', () => {
  const rows = tracking.collectShipments([{awb:AWB,job:'DG-1'}],[]).shipments;
  for (const subscriptionStatus of ['active','pending','unknown']) {
    const result = tracking.mergeTracking(rows,[{awb:AWB,status:'UNKNOWN',lastUpdate:null,subscriptionStatus}],true);
    assert.equal(result[0].status,'Awaiting first update',subscriptionStatus);
  }
  const placeholder = [{awb:AWB,status:'UNKNOWN',lastUpdate:null,subscriptionStatus:'not_subscribed'}];
  assert.equal(tracking.mergeTracking(rows,placeholder,true)[0].status,'Not tracked');
  assert.equal(tracking.mergeTracking(rows,placeholder,false)[0].status,'Tracking not connected');
  assert.equal(tracking.mergeTracking(rows,[{...placeholder[0],status:'DELIVERED',lastUpdate:'2026-09-26T10:00:00Z'}],false)[0].status,'DELIVERED');
});

function fixture(payload = {configured:false,liveEnabled:false,shipments:[]}, status = 200, source = {}) {
  const elements = new Map(), listeners = {}, requests = [], intervals = [], reportRenders = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id,value:'',innerHTML:'',textContent:'',disabled:false,options:[{value:''}],classList:{contains:() => id === 'tab-track'},addEventListener:(name, fn) => {listeners[id + ':' + name]=fn;}});
    return elements.get(id);
  };
  let authListener, confirmResult = false, confirmCount = 0;
  const confirmMessages = [];
  const auth = {access_token:'fixture-only',user:{id:'fixture-user'}};
  const sandbox = {module:{exports:{}},AbortController,console,Date,Blob,URL,
    document:{hidden:false,getElementById:element,addEventListener:()=>{}},
    window:{addEventListener:()=>{},confirm:message=>{confirmCount++;confirmMessages.push(message);return confirmResult;}},
    setInterval:fn=>{intervals.push(fn);return 1;},clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    fetch:async (url, init) => { requests.push({url,init});return {ok:status>=200&&status<300,status,json:async()=>payload}; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tracking.js'),'utf8'), sandbox);
  const api = sandbox.module.exports;
  api.init({readStore:key=>Object.prototype.hasOwnProperty.call(source,key) ? source[key] : key==='jfs_joblog'?[{awb:AWB,job:'<img src=x>',shipper:'Example'}]:[],getSession:async()=>({data:{session:auth}}),onAuthStateChange:cb=>{authListener=cb;},refreshReports:()=>reportRenders.push(api.reportCells(AWB,'')),milestones:{BKD:'BOOKED',DEP:'DEPARTED',DLV:'DELIVERED'}});
  return {api,requests,element,listeners,sandbox,auth,intervals,reportRenders,confirmMessages,authListener:()=>authListener,confirm:yes=>{confirmResult=yes;},confirmCount:()=>confirmCount,setResponse:(p,s=200)=>{payload=p;status=s;}};
}

test('Dashboard loads and polls stored tracking, refreshes report cells, and never starts paid tracking', async () => {
  const f = fixture({configured:true,liveEnabled:true,shipments:[{awb:AWB,status:'IN_TRANSIT',lastUpdate:'2026-09-26T10:00:00Z'}]});
  for (const id of ['tab-track','tab-rpt']) f.element(id).classList.contains = () => false;
  f.element('tab-dash').classList.contains = () => true;
  assert.equal(f.requests.length,0);
  f.api.onTab('dash');
  await new Promise(setImmediate);
  assert.equal(f.requests.length,1);
  assert.match(f.reportRenders.at(-1),/IN TRANSIT/);
  assert.match(f.reportRenders.at(-1),/10:00 UTC/);

  f.setResponse({configured:true,liveEnabled:true,shipments:[{awb:AWB,status:'DELIVERED',lastUpdate:'2026-09-26T11:00:00Z'}]});
  f.intervals[0]();
  await new Promise(setImmediate);
  assert.equal(f.requests.length,2);
  assert.match(f.reportRenders.at(-1),/DELIVERED/);
  assert.match(f.reportRenders.at(-1),/11:00 UTC/);

  f.sandbox.document.hidden = true;
  f.intervals[0]();
  await new Promise(setImmediate);
  assert.equal(f.requests.length,2);
  assert.equal(f.confirmCount(),0);
  for (const request of f.requests) {
    assert.equal(request.url,'/.netlify/functions/cargoai-tracking');
    assert.equal(request.init.method || 'GET','GET');
    assert.equal(request.init.headers.Authorization,'Bearer fixture-only');
  }
});

test('actual sign-in loads tracking only after a successful cloud pull in a visible report view', async () => {
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const entry = html.slice(html.indexOf('async function enterApp(user){'),html.indexOf('function setSync(state)'));
  const pull = html.slice(html.indexOf('async function cloudPullAll(tell){'),html.indexOf('/* live team sync'));
  for (const scenario of [{tab:'dash'},{tab:'track'},{tab:'rpt'},{tab:'dgd'},{tab:'dash',fail:true},{tab:'dash',hidden:true}]) {
    const f = fixture({configured:true,liveEnabled:true,shipments:[{awb:AWB,status:'IN_TRANSIT',lastUpdate:'2026-09-26T10:00:00Z'}]});
    for (const name of ['dash','track','rpt','dgd']) f.element('tab-'+name).classList.contains = () => scenario.tab === name;
    f.sandbox.document.hidden = !!scenario.hidden;
    f.sandbox.document.getElementById = id => { const el = f.element(id); el.style ||= {}; return el; };
    let finishCloud;
    const cloudGate = new Promise(resolve => { finishCloud = resolve; });
    const query = {select:()=>query,eq:()=>query,single:async()=>({data:{active:true}}),in:async()=>({data:[]})};
    Object.assign(f.sandbox,{DgTracking:f.api,sbUser:null,_inboxT:null,PRIVATE_KEYS:[],
      sb:{from:()=>query},localStorage:{setItem:()=>{}},userDisplayName:()=> 'Fixture user',
      cloudPullShared:async()=>{ await cloudGate; if(scenario.fail) throw new Error('Cloud unavailable'); }});
    f.sandbox.window.DgTracking = f.api;
    for (const name of ['renderDash','setSync','rebuildUNDB','fillPickers','loadDefaults','refreshDraftList','renderCustomers','refresh','dgdLogoApply','dgdLogoPull','aiKeyCloudPull','inboxPoll','teamSyncStart']) f.sandbox[name] = () => {};
    vm.runInNewContext(entry + '\n' + pull,f.sandbox);
    const signingIn = f.sandbox.enterApp({id:'fixture-user',email:'fixture@example.test'});
    await new Promise(setImmediate);
    assert.equal(f.requests.length,0,'No tracking GET before company data finishes loading');
    finishCloud();
    await signingIn;
    await new Promise(setImmediate);
    const shouldRefresh = scenario.tab !== 'dgd' && !scenario.fail && !scenario.hidden;
    assert.equal(f.requests.length,shouldRefresh ? 1 : 0,JSON.stringify(scenario));
    if (shouldRefresh) {
      assert.match(f.reportRenders.at(-1),/IN TRANSIT/);
      assert.equal(f.requests[0].url,'/.netlify/functions/cargoai-tracking');
      assert.equal(f.requests[0].init.method || 'GET','GET');
      assert.equal(f.requests[0].init.headers.Authorization,'Bearer fixture-only');
    }
    assert.equal(f.confirmCount(),0);
  }
});

test('unconfigured service lists real AWBs safely and makes no CargoAi or POST request', async () => {
  const f = fixture({configured:false,liveEnabled:false,shipments:[]},503);
  assert.equal(f.requests.length,0);
  await f.api.refresh();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'/.netlify/functions/cargoai-tracking');
  assert.equal(f.requests[0].init.headers.Authorization,'Bearer fixture-only');
  assert.equal(f.requests[0].init.method,undefined);
  assert.equal(f.element('tracking-sync').disabled,true);
  assert.equal(f.element('tracking-connection-title').textContent,'Automatic tracking setup incomplete');
  assert.ok(f.element('tracking-body').innerHTML.includes('&lt;img src=x&gt;'));
  await f.listeners['tracking-sync:click']();
  assert.equal(f.requests.length,1);
  assert.equal(f.confirmCount(),0);
});

test('live tracking stays paused until backend enablement; enabled POST requires explicit confirmation', async () => {
  const f = fixture({configured:true,liveEnabled:false,shipments:[]});
  await f.api.refresh();
  await f.listeners['tracking-sync:click']();
  assert.equal(f.requests.length,1);
  assert.equal(f.confirmCount(),0);
  f.setResponse({configured:true,liveEnabled:true,shipments:[]});
  await f.api.refresh();
  await f.listeners['tracking-sync:click']();
  assert.equal(f.confirmCount(),1);
  assert.equal(f.requests.filter(r=>r.init.method==='POST').length,0);
  f.confirm(true);
  await f.listeners['tracking-sync:click']();
  const post = f.requests.find(r=>r.init.method==='POST');
  assert.equal(post.init.body,'{"action":"sync"}');
});

test('pending signed callbacks show the server reason as text and cannot start tracking', async () => {
  const message = 'Signed webhook (HMAC) setup is pending. <img src=x onerror=alert(1)>';
  const f = fixture({configured:false,liveEnabled:false,shipments:[{awb:AWB,status:'IN_TRANSIT'}],message});
  await f.api.refresh();
  assert.equal(f.element('tracking-connection-title').textContent,'Automatic tracking setup incomplete');
  assert.ok(f.element('tracking-connection-text').textContent.includes(message));
  assert.equal(f.element('tracking-connection-text').innerHTML,'');
  assert.equal(f.api.reportInfo(AWB).status,'IN TRANSIT');
  assert.equal(f.element('tracking-sync').disabled,true);
  await f.listeners['tracking-sync:click']();
  assert.equal(f.requests.length,1);
  assert.equal(f.confirmCount(),0);
  f.authListener()('SIGNED_OUT',null);
  assert.ok(!f.element('tracking-connection-text').textContent.includes(message));
});

test('credit messaging follows server setup without assuming a Free plan or enabling paused requests', async () => {
  const message = 'Verified allowance: 150 credits. Application cap: 10 credits. Live requests are paused.';
  const f = fixture({configured:true,liveEnabled:false,shipments:[],message});
  await f.api.refresh();
  assert.equal(f.element('tracking-connection-title').textContent,'Tracking service configured · live requests paused');
  assert.ok(f.element('tracking-connection-text').textContent.includes(message));
  assert.ok(!/Free.plan/.test(f.element('tracking-connection-text').textContent));
  await f.listeners['tracking-sync:click']();
  assert.equal(f.confirmCount(),0);
  f.setResponse({configured:true,liveEnabled:true,shipments:[],message:{unexpected:'value'}});
  await f.api.refresh();
  assert.ok(!f.element('tracking-connection-text').textContent.includes(message));
  assert.ok(!f.element('tracking-connection-text').textContent.includes('[object Object]'));
  await f.listeners['tracking-sync:click']();
  assert.match(f.confirmMessages[0],/10 CargoCONNECT credits/);
  assert.match(f.confirmMessages[0],/configured application credit cap/);
  assert.match(f.confirmMessages[0],/does not change your plan/);
  assert.ok(!/Free.plan|paid plan will be purchased/.test(f.confirmMessages[0]));
  assert.equal(f.requests.filter(request=>request.init.method==='POST').length,0);
});

test('logout clears status and discards an old session response', async () => {
  const f = fixture({configured:true,liveEnabled:false,shipments:[{awb:AWB,status:'DELIVERED',lastUpdate:'2026-09-26T10:00:00Z'}]});
  await f.api.refresh();
  assert.equal(f.api.reportInfo(AWB).status,'DELIVERED');
  let resolve;
  f.sandbox.fetch = () => new Promise(done=>{resolve=done;});
  const pending = f.api.refresh();
  await new Promise(setImmediate);
  f.authListener()('SIGNED_OUT',null);
  resolve({ok:true,status:200,json:async()=>({configured:true,liveEnabled:true,shipments:[{awb:AWB,status:'DELIVERED'}]})});
  await pending;
  assert.equal(f.api.reportInfo(AWB).status,'Tracking not connected');
  assert.equal(f.element('tracking-sync').disabled,true);
});

test('delivered KPI counts only terminal delivery statuses, not partial or negated labels', async () => {
  const f = fixture();
  for (const status of ['NOT DELIVERED','PARTIALLY DELIVERED','DELIVERY PENDING','NOT DEPARTED']) {
    f.setResponse({configured:true,liveEnabled:false,shipments:[{awb:AWB,status}]});
    await f.api.refresh();
    assert.equal(f.element('tracking-delivered').textContent,0,status);
    assert.equal(f.element('tracking-moving').textContent,0,status);
  }
  f.setResponse({configured:true,liveEnabled:false,shipments:[{awb:AWB,status:'DLV'}]});
  await f.api.refresh();
  assert.equal(f.element('tracking-delivered').textContent,1);
  assert.equal(f.element('tracking-connection-title').textContent,'Tracking service configured · live requests paused');
});

test('server 503 explains the service error rather than silently presenting incomplete setup', async () => {
  const message = 'Tracking storage is temporarily unavailable.';
  const f = fixture({configured:false,liveEnabled:false,shipments:[],error:message,message},503);
  await f.api.refresh();
  assert.equal(f.element('tracking-connection-title').textContent,'Tracking temporarily unavailable');
  assert.equal(f.element('tracking-connection-text').textContent,message);
  assert.equal(f.element('tracking-sync').disabled,true);
  assert.equal(f.element('tracking-checked').textContent,'No tracking updates retrieved yet.');
});

const legacy = {
  '176-12345675':{awb:'176-12345675',job:'DG-1',route:'DXB - LHR',milestones:[{code:'BKD',ts:1700000000000,note:'Booking entered',by:'Operator'}],updated:1700000000000},
  '17612345675':{awb:'17612345675',job:'GC-2',milestones:[{code:'DLV',ts:1700000010000,note:'Legacy imported',src:'CARGO CONNECT'}],updated:1700000010000},
  'HOUSE-SAMPLE-01':{awb:'HOUSE-SAMPLE-01',job:'DG-HOUSE',milestones:[{code:'DEP',ts:1700000020000,note:'Manual house entry'}],updated:1700000020000}
};

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

test('manual DLV does not produce a CargoAi delivery or a delivered provider KPI', async () => {
  const f = fixture({configured:true,liveEnabled:true,shipments:[]},200,{jfs_tracking:legacy});
  await f.api.refresh();
  assert.equal(f.element('tracking-delivered').textContent,0);
  assert.equal(f.api.reportInfo(AWB).status,'Not tracked');
  assert.equal(f.api.reportInfo(AWB).manualStatus,'DLV');
  assert.equal(f.api.getRow(AWB).deliveredAt,null);
  assert.equal(f.api.reportInfo('HOUSE-SAMPLE-01').manualStatus,'DEP');
});

test('planned, predicted and split provider events stay distinct from recorded manual history in timeline and CSV', async () => {
  const events = [{code:'ARR',eventDate:'2026-09-26T18:00:00Z',isPlanned:true,isPredicted:true,isSplit:true,pieces:2,eventLocation:'DOH',flight:{number:'QR001'}}];
  const f = fixture({configured:true,liveEnabled:false,shipments:[{awb:AWB,status:'IN_TRANSIT',events,lastUpdate:'2026-09-26T10:00:00Z'}]},200,{jfs_tracking:legacy});
  await f.api.refresh();
  f.api.renderDetail(AWB);
  const html = f.element('trk_detail').innerHTML;
  assert.ok(html.includes('Predicted · Split shipment'));
  assert.ok(html.includes('Manual / legacy history'));
  assert.ok(html.includes('Legacy imported entry'));
  assert.ok(html.includes('Recorded '));
  assert.equal(f.api.getRow(AWB).arrivedAt,null);
  const csv = f.api.toCsv([f.api.getRow(AWB)]);
  assert.ok(csv.includes('Predicted · Split shipment'));
  assert.ok(csv.includes('Manual / legacy history (recorded times, not actual milestones)'));
  assert.ok(csv.includes('Legacy imported entry'));
});

test('targeted Auto posts only canonical selected AWB and invalid manual AWB never becomes bulk sync', async () => {
  const f = fixture({configured:true,liveEnabled:true,shipments:[]},200,{jfs_tracking:legacy});
  await f.api.refresh(); f.confirm(true);
  await f.api.sync('HOUSE-SAMPLE-01');
  assert.equal(f.requests.filter(request=>request.init.method==='POST').length,0);
  assert.equal(f.confirmCount(),0);
  await f.api.sync(AWB);
  const posts = f.requests.filter(request=>request.init.method==='POST');
  assert.equal(posts.length,1);
  assert.equal(posts[0].init.body,'{"action":"sync","awb":"176-12345675"}');
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

test('current index keeps a single tracking tab and no browser CargoCONNECT credential workflow', () => {
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.equal((html.match(/id="tab-track"/g)||[]).length,1);
  assert.equal((html.match(/id="nav-track"/g)||[]).length,1);
  assert.ok(!html.includes('id="tab-tracking"'));
  assert.ok(!html.includes('id="cc_key"'));
  assert.ok(!html.includes('function trackCCConfig'));
  assert.ok(!html.includes('fetch(cfg.url'));
  assert.ok(html.includes('prepareSync: trackCloudPush'));
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

test('CSV retains a manual-only shipment route when airport fields are unavailable', () => {
  const manual = {'HOUSE-01':{awb:'HOUSE-01',route:'DXB - LHR',milestones:[]}};
  const rows = tracking.mergeTracking(tracking.withManualHistory([],manual),[],false);
  const csv = tracking.toCsv(rows);
  assert.ok(csv.includes('"Route","Origin","Destination"'));
  assert.ok(csv.includes('"DXB - LHR","",""'));
});
