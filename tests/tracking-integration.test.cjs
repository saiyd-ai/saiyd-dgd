const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validateTrackingIntegration:validate} = require('../scripts/check-tracking-integration.cjs');
const rootDir=path.resolve(__dirname,'..');
const current=()=>fs.readFileSync(path.join(rootDir,'index.html'),'utf8');
const check=indexHtml=>validate({rootDir,indexHtml});

test('current host passes and presentation copy, quote style and asset cache versions may change', () => {
  assert.deepEqual(check(current()),{ok:true,errors:[]});
  const revised=current().replace('src="tracking.js"',"src='./tracking.js?v=2'").replace('href="tracking.css"',"href='/tracking.css?revision=next'").replace('Shipment focus','Operational view').replace('SHIPMENT TRACKING','SAVED SHIPMENT UPDATES');
  assert.deepEqual(check(revised),{ok:true,errors:[]});
});

test('an older host replacing the assets, host IDs and bootstrap is rejected with actionable diagnostics', () => {
  const reverted=current().replace(/<(?:script|link)\b[^>]*(?:src|href)="tracking(?:-report)?\.(?:js|css)"[^>]*>(?:<\/script>)?/g,'')
    .replace(/\bid="tracking-[^"]+"/g,'id="old-cargo-connect-control"')
    .replace('DgTracking.init({','LegacyTracking.init({')
    .replace('DgTrackingReport.open(rows, context)','LegacyReport.open(rows, context)');
  const result=check(reverted);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(error=>error.includes('load tracking.js')));
  assert.ok(result.errors.some(error=>error.includes('#tracking-body')));
  assert.ok(result.errors.some(error=>error.includes('DgTracking.init')));
  assert.ok(result.errors.some(error=>error.includes('openReport')));
});

test('commented asset references and IDs inside JavaScript strings cannot satisfy host requirements', () => {
  const fake=current().replace('<script src="tracking.js"></script>','<!-- <script src="tracking.js"></script> -->')
    .replace('id="tracking-body"','id="old-tracking-body"') + '<script>const exampleMarkup=\'<tbody id="tracking-body"></tbody>\';</script>';
  const result=check(fake);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(error=>error.includes('load tracking.js')));
  assert.ok(result.errors.some(error=>error.includes('#tracking-body')));
});

test('missing or duplicate essential controls fail instead of silently producing an empty report', () => {
  const missing=check(current().replace('id="tracking-print"','id="old-print"'));
  assert.ok(missing.errors.some(error=>error.includes('#tracking-print')));
  const duplicate=check(current()+'<div id="tracking-body"></div>');
  assert.ok(duplicate.errors.some(error=>error.includes('#tracking-body') && error.includes('found 2')));
});

test('commented bootstrap, absent report callback, and late script loading are rejected', () => {
  const boot=current().match(/if\(window\.DgTracking\) DgTracking\.init\(\{[\s\S]*?\n\}\);/);
  assert.ok(boot,'The current host bootstrap must be available to this regression test.');
  const commented=check(current().replace(boot[0],'/* '+boot[0]+' */'));
  assert.ok(commented.errors.some(error=>error.includes('bootstrap')));
  const noReport=check(current().replace('DgTrackingReport.open(rows, context)','unavailableReport(rows, context)'));
  assert.ok(noReport.errors.some(error=>error.includes('openReport')));
  const late=check(current().replace('src="tracking.js"','defer src="tracking.js"'));
  assert.ok(late.errors.some(error=>error.includes('synchronously')));
});

test('missing asset files and broken inline JavaScript stop deployment with concise errors', () => {
  const missing=validate({rootDir:path.join(rootDir,'__nonexistent_tracking_fixture__'),indexHtml:current()});
  assert.ok(missing.errors.some(error=>error==='tracking.js is missing or unreadable.'));
  const syntax=check(current()+'<script>const = invalid;</script>');
  assert.ok(syntax.errors.some(error=>error.includes('invalid JavaScript')));
});
