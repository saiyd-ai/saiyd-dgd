'use strict';
// The dashboard needs one file with no remote imports or Node-only WebSocket code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.join(__dirname, '..');
const DENO_VERSION = '2.9.6';
const OUTPUT = path.join(ROOT, 'output/skyd-prepare');
const ENTRY = 'supabase/functions/skyd-prepare/index.ts';
const LOCK = 'scripts/skyd-deno.lock';
const BUNDLE = path.join(OUTPUT, 'skyd-prepare-deploy.mjs');
const SOURCES = [
  'supabase/functions/dg-inbox/media-validation.mjs',
  'supabase/functions/skyd-prepare/skyd-fields.mjs',
  'supabase/functions/skyd-prepare/skyd-runtime.mjs',
  'supabase/functions/skyd-prepare/skyd-handler.mjs',
  'supabase/functions/skyd-prepare/skyd-awb-pdf.mjs',
  'scripts/build-skyd-prepare.cjs',
  'scripts/build-skyd-bundle.cjs',
];

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function hashFile(file) { return sha256(fs.readFileSync(file)); }
function runDeno(args, options = {}) {
  // Invoke npm's JS entry with Node so Windows .cmd quoting never interprets paths.
  const npmExec = process.env.npm_execpath;
  const candidates = [
    npmExec && path.join(path.dirname(npmExec), 'npx-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
  ].filter(Boolean);
  const npx = candidates.find(file => fs.existsSync(file));
  if (npx) return execFileSync(process.execPath, [npx, '--yes', 'deno@' + DENO_VERSION, ...args], { cwd: ROOT, ...options });
  if (process.platform === 'win32') throw new Error('A standard Node/npm installation with npx-cli.js is required.');
  return execFileSync('npx', ['--yes', 'deno@' + DENO_VERSION, ...args], { cwd: ROOT, ...options });
}

function assertSelfContained(source) {
  if (/\bimport\s*(?:\(|["'{*]|[a-z_$][\w$]*\s*(?:,|from\b))/.test(source)) {
    throw new Error('Deployment bundle still contains an external module import.');
  }
  if (/\b(?:require|__deno_internal_createRequire)\s*\(|node:module/.test(source)) {
    throw new Error('Deployment bundle still requires Node module loading.');
  }
}

function verifyBoot() {
  const wrapper = path.join(OUTPUT, 'synthetic-boot-check.ts');
  fs.writeFileSync(wrapper, `// Synthetic only: no production secrets, storage or provider calls.
delete (globalThis as Record<string, unknown>).global;
Deno.env.set('SUPABASE_URL','https://synthetic.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','synthetic-test-key-not-a-credential');
let lookups=0;
globalThis.fetch=async(input: RequestInfo | URL)=>{
  const url=new URL(input instanceof Request ? input.url : String(input));
  if(url.hostname!=='synthetic.invalid' || url.pathname!=='/rest/v1/dg_inbox_config') throw new Error('Unexpected synthetic request');
  lookups++;
  return new Response(JSON.stringify({value:'synthetic-shared-key'}),{status:200,headers:{'content-type':'application/json'}});
};
let handler: ((request: Request)=>Promise<Response>) | undefined;
Deno.serve=((value: unknown)=>{handler=value as typeof handler;return {};}) as typeof Deno.serve;
await import(${JSON.stringify(pathToFileURL(BUNDLE).href)});
if(typeof handler!=='function') throw new Error('Worker did not register');
const get=await handler(new Request('https://synthetic.invalid/skyd-prepare'));
if(get.status!==405 || (await get.json()).error!=='POST only') throw new Error('GET method guard failed');
const options=await handler(new Request('https://synthetic.invalid/skyd-prepare',{method:'OPTIONS'}));
if(options.status!==200) throw new Error('OPTIONS guard failed');
const denied=await handler(new Request('https://synthetic.invalid/skyd-prepare',{method:'POST',headers:{'x-dg-key':'wrong'},body:'{}'}));
if(denied.status!==401 || (await denied.json()).error!=='unauthorized') throw new Error('Authentication guard failed');
if(lookups!==1 || typeof (globalThis as Record<string, unknown>).global!=='undefined') throw new Error('Unexpected runtime behavior');
console.log(JSON.stringify({boot:'passed',globalAbsent:true,methods:[405,200,401],syntheticConfigLookups:lookups}));
`);
  return JSON.parse(runDeno(['run', '--no-config', '--no-lock', '--no-remote', '--no-npm', '--allow-env', wrapper], { encoding: 'utf8', timeout: 30000 }).trim());
}

function buildBundle({ deployedBundle } = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  execFileSync(process.execPath, ['scripts/build-skyd-prepare.cjs'], { cwd: ROOT, stdio: 'inherit' });
  const version = runDeno(['--version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
  if (!version.startsWith('deno ' + DENO_VERSION + ' ')) throw new Error('Unexpected Deno version: ' + version);
  if (!fs.existsSync(path.join(ROOT, LOCK))) throw new Error('Reviewed SKYD dependency lock is missing.');
  const args = ['bundle', '--no-config', '--lock=' + LOCK, '--frozen-lockfile',
    '--allow-import=cdn.sheetjs.com,registry.npmjs.org', '--platform=browser', '--minify',
    '--output=' + path.relative(ROOT, BUNDLE), ENTRY];
  runDeno(args, { stdio: 'inherit', timeout: 120000 });
  const bytes = fs.readFileSync(BUNDLE);
  assertSelfContained(bytes.toString('utf8'));
  const boot = verifyBoot();
  const sources = Object.fromEntries(SOURCES.map(file => [file, hashFile(path.join(ROOT, file))]));
  const manifest = {
    format: 1,
    tool: { name: 'deno', version: DENO_VERSION, platform: 'browser', minified: true },
    command: ['npx', '--yes', 'deno@' + DENO_VERSION, ...args],
    reviewedSourceSha256: sha256(Buffer.from(JSON.stringify(sources))),
    sources,
    generatedEntry: { path: ENTRY, sha256: hashFile(path.join(ROOT, ENTRY)) },
    dependencyLock: { path: LOCK, sha256: hashFile(path.join(ROOT, LOCK)) },
    artifact: { path: 'output/skyd-prepare/skyd-prepare-deploy.mjs', bytes: bytes.length, sha256: sha256(bytes) },
    externalImports: [],
    boot,
  };
  if (deployedBundle) {
    const reference = path.resolve(deployedBundle);
    const hash = hashFile(reference);
    manifest.deploymentReference = { sha256: hash, matchesArtifact: hash === manifest.artifact.sha256 };
    if (!manifest.deploymentReference.matchesArtifact) throw new Error('The provided deployed artifact differs from the reproduced bundle.');
  }
  fs.writeFileSync(path.join(OUTPUT, 'integrity-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ artifact: manifest.artifact, sourceSha256: manifest.reviewedSourceSha256, boot, manifest: 'output/skyd-prepare/integrity-manifest.json' }, null, 2));
  return manifest;
}

if (require.main === module) {
  const extra = process.argv.slice(2);
  if (extra.length && (extra.length !== 2 || extra[0] !== '--deployed-bundle')) throw new Error('Usage: build-skyd-bundle.cjs [--deployed-bundle <reviewed artifact path>]');
  buildBundle({ deployedBundle: extra[1] });
}
module.exports = { DENO_VERSION, buildBundle, assertSelfContained, sha256 };
