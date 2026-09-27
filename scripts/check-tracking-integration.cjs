'use strict';
// Build-time contract guard against publishing an older host page over the tracking integration.
// This validates structure and wiring, not page copy or a checksum of the whole application.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ASSETS = ['tracking.js','tracking.css','tracking-report.js','tracking-report.css'];
const HOST_IDS = ['tab-track','tracking-connection','tracking-connection-title','tracking-connection-text',
  'tracking-total','tracking-updates','tracking-pending','tracking-unlinked','tracking-unlinked-label',
  'tracking-search','tracking-filter','tracking-import','tracking-refresh','tracking-print','tracking-export',
  'tracking-focus','tracking-action-message','tracking-count','tracking-checked','tracking-body','trk_detail','tracking-invalid'];
function attributes(tag) {
  const values = Object.create(null);
  const body = tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?\s*>$/, '');
  for (const match of body.matchAll(/([^\s=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    values[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return values;
}
function parseHost(html) {
  const tags = [], scripts = [];
  // Consume entire script elements so markup in JS strings cannot supply missing host elements.
  const tokens = /<!--[\s\S]*?-->|<script\b(?:"[^"]*"|'[^']*'|[^'">])*\>[\s\S]*?<\/script\s*>|<[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*\>/gi;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    const opening = token.match(/^<[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*\>/i)[0];
    const name = opening.match(/^<([\w:-]+)/)[1].toLowerCase();
    const attrs = attributes(opening);
    tags.push({name,attrs});
    if (name === 'script') scripts.push({attrs,code:token.slice(opening.length).replace(/<\/script\s*>$/i,'')});
  }
  return {tags,scripts};
}
function localAsset(value) {
  const clean = String(value || '').split(/[?#]/,1)[0];
  return clean.replace(/^\.\//,'').replace(/^\//,'');
}
function hostCode(source) {
  // These integration calls are top-level host statements. Ignore whole-line and block comments;
  // this is an accidental-reversion contract check, not a general JavaScript/security parser.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\r\n]*/gm, '');
}
function validateTrackingIntegration({rootDir=path.resolve(__dirname,'..'),indexHtml}={}) {
  const errors=[];
  const fail=message=>errors.push(message);
  let html=indexHtml;
  if(html===undefined) {
    try { html=fs.readFileSync(path.join(rootDir,'index.html'),'utf8'); }
    catch { return {ok:false,errors:['index.html is missing or unreadable.']}; }
  }
  const {tags,scripts}=parseHost(String(html));
  for(const asset of ASSETS) {
    const matches=tags.filter(tag=>asset.endsWith('.js') ? tag.name==='script' && localAsset(tag.attrs.src)===asset : tag.name==='link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(tag.attrs.rel || '') && localAsset(tag.attrs.href)===asset);
    if(matches.length!==1) fail('index.html must load '+asset+' exactly once (found '+matches.length+').');
    if(asset.endsWith('.js') && matches.some(tag=>'async' in tag.attrs || /^(?:module|application\/json)$/i.test(tag.attrs.type || ''))) fail(asset+' must remain a classic script loaded before the inline tracking bootstrap; async/module loading requires a coordinated host change.');
    try {
      const content=fs.readFileSync(path.join(rootDir,asset),'utf8');
      if(!content.trim()) fail(asset+' is empty.');
      if(asset.endsWith('.js')) { try { new vm.Script(content,{filename:asset}); } catch(error) { fail(asset+' has invalid JavaScript: '+error.message); } }
    } catch { fail(asset+' is missing or unreadable.'); }
  }
  for(const id of HOST_IDS) {
    const matches=tags.filter(tag=>tag.attrs.id===id);
    if(matches.length!==1) fail('Tracking host element #'+id+' must exist exactly once (found '+matches.length+').');
  }
  const inline=scripts.filter(script=>!('src' in script.attrs) && (!script.attrs.type || /^(?:text|application)\/javascript$/i.test(script.attrs.type)));
  const code=[];
  for(let index=0;index<inline.length;index++) {
    try { new vm.Script(inline[index].code,{filename:'index.html inline script '+(index+1)}); }
    catch(error) { fail('index.html inline script '+(index+1)+' has invalid JavaScript: '+error.message); }
    code.push(hostCode(inline[index].code));
  }
  const executable=code.join('\n');
  const bootstrap=/^\s*(?:if\s*\([^\n]*\)\s*)?(?:window\s*\.\s*)?DgTracking\s*\.\s*init\s*\(/gm;
  const calls=[...executable.matchAll(bootstrap)];
  if(calls.length!==1) fail('The executable DgTracking.init(...) host bootstrap must exist exactly once (found '+calls.length+').');
  if(!/^\s*openReport\s*:\s*[^\n]*\bDgTrackingReport\s*\.\s*open\s*\(/m.test(executable)) fail('The tracking bootstrap is missing its openReport callback to DgTrackingReport.open(...).');
  // An include moved below the bootstrap or marked defer will execute too late for this inline host.
  const bootstrapScript=scripts.findIndex(script=>!('src' in script.attrs) && /^\s*(?:if\s*\([^\n]*\)\s*)?(?:window\s*\.\s*)?DgTracking\s*\.\s*init\s*\(/m.test(hostCode(script.code)));
  if(bootstrapScript>=0) for(const asset of ASSETS.filter(name=>name.endsWith('.js'))) {
    const position=scripts.findIndex(script=>localAsset(script.attrs.src)===asset);
    if(position>bootstrapScript || (position>=0 && 'defer' in scripts[position].attrs)) fail(asset+' must load synchronously before the inline DgTracking.init bootstrap.');
  }
  return {ok:errors.length===0,errors};
}
if(require.main===module) {
  const result=validateTrackingIntegration();
  if(result.ok) console.log('Tracking integration check passed: host, assets and report wiring are present.');
  else {
    console.error('Tracking integration check failed. Deployment stopped to prevent an outdated index.html from replacing the working tracking page.');
    for(const error of result.errors) console.error(' - '+error);
    console.error('Restore or reconcile the tracking host integration in index.html, then run npm run validate:tracking again.');
    process.exitCode=1;
  }
}
module.exports={validateTrackingIntegration};
