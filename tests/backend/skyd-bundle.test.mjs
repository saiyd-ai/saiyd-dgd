import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {DENO_VERSION,assertSelfContained,sha256}=require('../../scripts/build-skyd-bundle.cjs');

test('deployment gate rejects runtime module loads, including the failed Node bundle',()=>{
  assert.equal(DENO_VERSION,'2.9.6');
  for(const source of [
    'import {createClient} from "npm:@supabase/supabase-js@2.45.4";',
    'import runtime from "some-package";',
    'import "https://cdn.sheetjs.com/xlsx.mjs";',
    'await import("node:module");',
    'import{createRequire as cr}from"node:module";cr(import.meta.url);',
    'const library=require("ws");',
  ]) assert.throws(()=>assertSelfContained(source),/module/);
  assert.doesNotThrow(()=>assertSelfContained('var value=1;Deno.serve(()=>new Response(String(value)));'));
});

test('frozen runtime lock preserves official workbook URL and pinned npm roots',()=>{
  const lock=JSON.parse(fs.readFileSync(new URL('../../scripts/skyd-deno.lock',import.meta.url),'utf8'));
  assert.equal(lock.specifiers['npm:@supabase/supabase-js@2.45.4'],'2.45.4');
  assert.equal(lock.specifiers['npm:pdf-lib@1.17.1'],'1.17.1');
  assert.match(lock.remote['https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'],/^[a-f0-9]{64}$/);
  const builder=fs.readFileSync(new URL('../../scripts/build-skyd-prepare.cjs',import.meta.url),'utf8');
  assert.doesNotMatch(builder,/jsr:@supabase\/functions-js/);
  const bundleBuilder=fs.readFileSync(new URL('../../scripts/build-skyd-bundle.cjs',import.meta.url),'utf8');
  assert.match(bundleBuilder,/--platform=browser/);assert.match(bundleBuilder,/--frozen-lockfile/);
  assert.match(bundleBuilder,/--no-remote/);assert.match(bundleBuilder,/--no-npm/);
});

test('built artifact hash and boot proof match the reviewed source manifest',t=>{
  const manifestUrl=new URL('../../output/skyd-prepare/integrity-manifest.json',import.meta.url);
  if(!fs.existsSync(manifestUrl)){t.skip('Run build:skyd:bundle to produce the ignored deployment artifact.');return;}
  const manifest=JSON.parse(fs.readFileSync(manifestUrl,'utf8'));
  const bundle=fs.readFileSync(new URL('../../'+manifest.artifact.path,import.meta.url));
  assert.equal(sha256(bundle),manifest.artifact.sha256);assert.equal(bundle.length,manifest.artifact.bytes);
  assert.equal(sha256(Buffer.from(JSON.stringify(manifest.sources))),manifest.reviewedSourceSha256);
  for(const [file,hash] of Object.entries(manifest.sources)) assert.equal(sha256(fs.readFileSync(new URL('../../'+file,import.meta.url))),hash,'Review provenance changed: '+file);
  assertSelfContained(bundle.toString('utf8'));
  assert.deepEqual(manifest.externalImports,[]);assert.equal(manifest.boot.globalAbsent,true);
  assert.deepEqual(manifest.boot.methods,[405,200,401]);
  if(manifest.deploymentReference) assert.equal(manifest.deploymentReference.matchesArtifact,true);
});
