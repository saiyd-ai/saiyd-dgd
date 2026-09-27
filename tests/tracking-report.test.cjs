const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const report = require('../tracking-report.js');
const source = fs.readFileSync(path.join(__dirname,'../tracking-report.js'),'utf8');
const row = () => ({awb:'17612345675',airlineName:'Example Airline',origin:'DXB',destination:'LHR',consignee:'Example consignee',status:'RCF',lastUpdate:'2026-09-24T22:03:00Z',fetchedAt:'2026-09-27T01:00:00Z',providerResult:{provider:'trackcargo',statusDescription:'Received from flight',currentLocation:'VIE',dataStatus:'AVAILABLE',orderId:'private-order-not-for-report',raw:{secret:'never-copy-provider-payload'}},manualEvents:[{source:'Manual entry',code:'NOTE',note:'Operator checked the airline.',ts:'2026-09-25T23:00:00Z'}]});
const context = {generatedAt:'2026-09-27T04:00:00Z',checkedAt:'2026-09-27T01:00:00Z',filterSummary:'Needs attention'};

test('saved report converts event, retrieval, generated and manual times to Dubai without changing instants', () => {
  const input = row(), before = JSON.stringify(input);
  const html = report.render([input],context);
  assert.match(html,/25 Sept? 2026, 02:03 Dubai \(UTC\+4\)/);
  assert.match(html,/27 Sept? 2026, 05:00 Dubai \(UTC\+4\)/);
  assert.match(html,/27 Sept? 2026, 08:00 Dubai \(UTC\+4\)/);
  assert.match(html,/26 Sept? 2026, 03:00 Dubai \(UTC\+4\)/);
  assert.match(html,/datetime="2026-09-24T22:03:00.000Z"/);
  assert.match(html,/Carrier event time/); assert.match(html,/Last checked/); assert.match(html,/Recorded:/);
  assert.match(html,/DXB[\s\S]*→[\s\S]*LHR/);
  assert.equal(JSON.stringify(input),before);
});

test('provider, notes, identifiers and filter labels are escaped; raw provider payloads are excluded', () => {
  const input = row();
  input.airlineName='<img src=x onerror=alert(1)>'; input.origin='DXB<script>bad</script>'; input.consignee='Customer & <b>Co</b>';
  input.providerResult.statusDescription='<svg onload=alert(2)>'; input.manualEvents[0].note='"<script>alert(3)</script> & note';
  input.attentionReasons=['<iframe src=x>'];
  const html = report.render([input],{...context,filterSummary:'<script>filter</script>',error:'<img src=x>'});
  assert.ok(!/<script|<img|<svg|<iframe/.test(html));
  assert.match(html,/&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html,/Customer &amp; &lt;b&gt;Co&lt;\/b&gt;/);
  assert.ok(!html.includes('private-order-not-for-report')); assert.ok(!html.includes('never-copy-provider-payload'));
  assert.match(html,/&lt;iframe src=x&gt;/);
});

test('pending, unlinked and failed records do not invent a delivered event or event time', () => {
  const pending={...row(),status:'Awaiting carrier result',lastUpdate:null,providerResult:{provider:'trackcargo',dataStatus:'INCONCLUSIVE'}};
  const unlinked={...row(),status:'Not linked to TrackCargo',lastUpdate:null,fetchedAt:null,providerResult:null};
  const failed={...row(),status:'TrackCargo unavailable',lastUpdate:'2026-09-24T22:03:00Z',providerResult:{provider:'trackcargo',dataStatus:'ERROR'}};
  const html=report.render([pending,unlinked,failed],context);
  assert.match(html,/Awaiting an airline response/); assert.match(html,/No tracking order linked/);
  assert.match(html,/Unavailable — retrieval failed/); assert.match(html,/The tracking result could not be retrieved/);
  assert.ok(!html.includes('25 Sept 2026, 02:03')); assert.ok(!html.includes('DELIVERED'));
});

test('manual entry remains separate from carrier status and legacy history is not relabelled manual', () => {
  const input=row();
  input.manualEvents=[{source:'CargoAi legacy',code:'DLV',note:'Do not promote legacy to manual',ts:'2026-09-27T02:00:00Z'},{source:'Manual entry',code:'NOTE',note:'Earlier operator note',ts:'2026-09-24T00:00:00Z'},{source:'Manual entry',code:'DLV',note:'Operator delivery note',ts:'2026-09-25T00:00:00Z'}];
  const html=report.render([input],context);
  assert.match(html,/TrackCargo · carrier result<\/span><strong>RCF<\/strong>/);
  assert.match(html,/Manual entry · operator recorded<\/span><strong>DLV<\/strong>/);
  assert.match(html,/Operator delivery note/); assert.ok(!html.includes('Earlier operator note')); assert.ok(!html.includes('Do not promote legacy to manual'));
  assert.match(html,/may cover only part of a shipment/);
});

test('report has honest empty scope and invalid timestamps rather than Invalid Date', () => {
  const empty=report.render([],{generatedAt:'invalid',filterSummary:'Route filter',checkedAt:null});
  assert.match(empty,/No shipments match this view/); assert.match(empty,/<b>0<\/b> shipments/); assert.match(empty,/Route filter/);
  const input=row(); input.lastUpdate='invalid'; input.fetchedAt='invalid'; input.origin='ADDR. OF FIRST CARRIER AND REQUESTED ROUTING';
  const html=report.render([input],context);
  assert.ok(!html.includes('Invalid Date')); assert.match(html,/Needs review — check saved AWB details/);
  assert.ok(!html.includes('ADDR. OF FIRST CARRIER')); assert.match(html,/does not fetch new tracking results/);
});

function browserFixture() {
  const doc={activeElement:null};
  class Element {
    constructor(tag='div') {this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map();this.listeners=new Map();this.style={overflow:''};this.className='';this.value='';this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name)};}
    setAttribute(name,value){this.attributes.set(name,String(value));} getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;} hasAttribute(name){return this.attributes.has(name);} removeAttribute(name){this.attributes.delete(name);}
    appendChild(child){this.children.push(child);child.parentNode=this;return child;} remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this);this.parentNode=null;}
    get isConnected(){return this===doc.body || !!this.parentNode?.isConnected;} focus(){doc.activeElement=this;}
    addEventListener(type,fn){this.listeners.set(type,fn);} removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);}
    querySelector(selector){return this.parts?.[selector] || null;}
    set innerHTML(value){this.html=value;this.parts={'[data-report-action="print"]':new Element('button'),'[data-report-action="close"]':new Element('button'),'.dgdoc-report-preview-body':new Element('div')};Object.values(this.parts).forEach(part=>this.appendChild(part));}
    get innerHTML(){return this.html || '';}
  }
  doc.body=new Element('body');doc.body.style.overflow='scroll';doc.createElement=tag=>new Element(tag);
  const app=doc.body.appendChild(new Element('main')), input=app.appendChild(new Element('input'));input.value='unsaved shipment edit';input.focus();
  const alreadyInert=doc.body.appendChild(new Element('aside'));alreadyInert.setAttribute('inert','original');
  let prints=0,requests=0;
  const sandbox={module:{exports:{}},document:doc,Date,print:()=>prints++,fetch:()=>{requests++;throw new Error('No network allowed');}};
  vm.runInNewContext(source,sandbox);
  return {api:sandbox.module.exports,doc,app,input,alreadyInert,prints:()=>prints,requests:()=>requests,overlay:()=>doc.body.children.find(element=>element.className==='dgdoc-report-overlay')};
}

test('opening only previews; print is explicit; closing restores app state, focus and existing inert attributes', () => {
  const f=browserFixture();
  const controller=f.api.open([row()],context), overlay=f.overlay();
  assert.equal(f.prints(),0);assert.equal(f.requests(),0);assert.ok(f.app.hasAttribute('inert'));assert.ok(f.doc.body.classList.contains('dgdoc-report-open'));
  assert.equal(overlay.getAttribute('role'),'dialog');assert.equal(overlay.getAttribute('aria-modal'),'true');
  const close=overlay.querySelector('[data-report-action="close"]'), print=overlay.querySelector('[data-report-action="print"]');
  assert.equal(f.doc.activeElement,close);print.listeners.get('click')();assert.equal(f.prints(),1);
  controller();assert.equal(f.overlay(),undefined);assert.equal(f.doc.activeElement,f.input);assert.equal(f.input.value,'unsaved shipment edit');assert.equal(f.doc.body.style.overflow,'scroll');
  assert.equal(f.app.hasAttribute('inert'),false);assert.equal(f.alreadyInert.getAttribute('inert'),'original');assert.equal(f.doc.body.classList.contains('dgdoc-report-open'),false);assert.equal(print.listeners.size,0);
  controller();assert.equal(f.input.value,'unsaved shipment edit');
});

test('modal traps keyboard focus, handles Escape and safely replaces an existing preview', () => {
  const f=browserFixture(); f.api.open([row()],context);
  const first=f.overlay(), print=first.querySelector('[data-report-action="print"]'), region=first.querySelector('.dgdoc-report-preview-body');
  let prevented=0; print.focus();first.listeners.get('keydown')({key:'Tab',shiftKey:true,preventDefault:()=>prevented++});assert.equal(f.doc.activeElement,region);
  first.listeners.get('keydown')({key:'Tab',shiftKey:false,preventDefault:()=>prevented++});assert.equal(f.doc.activeElement,print);assert.equal(prevented,2);
  f.api.open([],{...context,filterSummary:'New view'});assert.ok(!first.isConnected);assert.equal(f.doc.body.children.filter(el=>el.className==='dgdoc-report-overlay').length,1);
  const second=f.overlay();second.listeners.get('keydown')({key:'Escape',preventDefault:()=>prevented++});assert.equal(f.overlay(),undefined);assert.equal(f.doc.activeElement,f.input);assert.equal(f.requests(),0);
});

test('print stylesheet uses an isolated named page and hides only report-preview app siblings', () => {
  const css=fs.readFileSync(path.join(__dirname,'../tracking-report.css'),'utf8');
  assert.match(css,/@page dgdocTrackingReport\{size:A4 landscape/);
  assert.match(css,/page:dgdocTrackingReport/);
  assert.match(css,/body\.dgdoc-report-open>:not\(\.dgdoc-report-overlay\)\{display:none!important/);
});
