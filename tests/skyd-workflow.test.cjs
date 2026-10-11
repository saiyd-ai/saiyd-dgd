'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {extendWorkflow} = require('../scripts/build-skyd-workflow.cjs');

const OWNER = '971562977774';
const BASE = 'https://jojtqlfhmkvdegqbwvtj.supabase.co/functions/v1';
const INBOX = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const DELIVERY_NAMES = ['SKYD draft ready?', 'Claim SKYD delivery', 'SKYD delivery claimed?', 'Send SKYD draft PDF', 'Record SKYD delivery'];

function baseline() {
  const names = ['From Netlify', 'Parse', 'Remove Duplicates', 'Has file?', 'Media URL', 'Download file', 'Add file', 'DGDOC inbox', 'Reply?', 'WhatsApp reply'];
  const workflow = {
    id: 'synthetic-workflow-id', name: 'Synthetic JFS DG DESK workflow',
    nodes: names.map((name, index) => ({name, id: `original-${index}`, type: 'original-node', parameters: {sentinel: name}, position: [index * 100, 0]})),
    connections: {}, settings: {executionOrder: 'v1', saveExecutionProgress: true},
  };
  const inbox = workflow.nodes.find(node => node.name === 'DGDOC inbox');
  inbox.parameters = {
    method: 'POST', url: `${BASE}/dg-inbox`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
    options: {timeout: 10000, redirect: {redirect: {followRedirects: false}}},
  };
  inbox.credentials = {httpHeaderAuth: {id: 'synthetic-dg-key-reference', name: 'Synthetic DGDOC inbox'}};
  workflow.nodes.find(node => node.name === 'WhatsApp reply').credentials = {whatsAppApi: {id: 'synthetic-whatsapp-reference', name: 'Synthetic WhatsApp Cloud'}};
  const edge = (from, to) => {workflow.connections[from] = {main: [[{node: to, type: 'main', index: 0}]]};};
  edge('From Netlify', 'Parse'); edge('Parse', 'Remove Duplicates'); edge('Remove Duplicates', 'Has file?');
  workflow.connections['Has file?'] = {main: [[{node: 'Media URL', type: 'main', index: 0}], [{node: 'DGDOC inbox', type: 'main', index: 0}]]};
  edge('Media URL', 'Download file'); edge('Download file', 'Add file'); edge('Add file', 'DGDOC inbox'); edge('DGDOC inbox', 'Reply?'); edge('Reply?', 'WhatsApp reply');
  return workflow;
}

function evaluate(expression, json, referenced = {}) {
  assert.ok(expression.startsWith('={{') && expression.endsWith('}}'), 'Expression wrapper');
  const code = expression.slice(3, -2).trim();
  return vm.runInNewContext(code, {
    $json: json, URL, decodeURIComponent,
    $: name => ({item: {json: referenced[name]}}),
  }, {timeout: 1000});
}

function jsonExpression(expression, json, referenced) {
  return JSON.parse(evaluate(expression, json, referenced));
}

function workflow() {return extendWorkflow(baseline());}
function node(name, graph = workflow()) {return graph.nodes.find(item => item.name === name);}
function claim(extra = {}) {
  const artifact = `skyd-awb/${INBOX}/v1-${RUN}.pdf`;
  return {
    run_id: RUN, inbox_id: INBOX, version: 1, job_no: 'AEXP-C00465', claim_token: TOKEN,
    to: OWNER, artifact_path: artifact, filename: 'AEXP-C00465-AWB-DRAFT-v1.pdf',
    download_url: `https://jojtqlfhmkvdegqbwvtj.supabase.co/storage/v1/object/sign/dgdocs/${artifact}?token=synthetic`,
    ...extra,
  };
}

test('extending SKYD leaves the baseline immutable and preserves every ordinary intake and reply node', () => {
  const original = baseline(), before = structuredClone(original), extended = extendWorkflow(original);
  assert.deepEqual(original, before);
  assert.equal(extended.nodes.length, original.nodes.length + 5);
  for (const existing of original.nodes) {
    if (existing.name === 'DGDOC inbox') continue;
    assert.deepEqual(extended.nodes.find(item => item.name === existing.name), existing);
  }
  for (const [name, edges] of Object.entries(original.connections)) {
    if (name === 'DGDOC inbox') continue;
    assert.deepEqual(extended.connections[name], edges);
  }
  const inbox = node('DGDOC inbox', extended);
  assert.deepEqual(inbox.credentials, original.nodes.find(item => item.name === 'DGDOC inbox').credentials);
  assert.equal(inbox.parameters.jsonBody, '={{ JSON.stringify($json.body) }}');
  assert.equal(inbox.parameters.options.redirect.redirect.followRedirects, false);
  assert.equal(inbox.parameters.options.timeout, 120000);
  assert.equal(extended.settings.saveExecutionProgress, false);
  assert.equal(extended.settings.executionOrder, 'v1');
});

test('ordinary DG commands, shipment text and every media caption continue to the existing inbox', () => {
  const expression = node('DGDOC inbox').parameters.url;
  for (const text of ['DG AEXP-C00465', 'AWB 020-12345678\nShipper: Sample Company', 'SKYDIVING GOODS', 'Prepare cargo']) {
    assert.equal(evaluate(expression, {body: {type: 'text', text}}), `${BASE}/dg-inbox`);
  }
  for (const type of ['document', 'image']) {
    for (const caption of ['Invoice for AEXP-C00465', 'SKYD PREPARE AEXP-C00465 AWB']) {
      assert.equal(evaluate(expression, {body: {type, text: '', caption, file: {name: 'synthetic.pdf'}}}), `${BASE}/dg-inbox`);
    }
  }
  assert.equal(evaluate(expression, {}), `${BASE}/dg-inbox`);
});

test('standalone SKYD text reaches the preparation endpoint for strict backend syntax validation', () => {
  const expression = node('DGDOC inbox').parameters.url;
  for (const text of ['SKYD PREPARE AEXP-C00465 AWB', ' skyd prepare dgs-c00422 awb ', 'SKYD invalid command']) {
    assert.equal(evaluate(expression, {body: {type: 'text', text}}), `${BASE}/skyd-prepare`);
  }
});

test('only a ready draft and an acquired delivery claim can reach the document send branch', () => {
  const graph = workflow();
  const inboxEdges = graph.connections['DGDOC inbox'].main[0].map(edge => edge.node);
  assert.deepEqual(inboxEdges, ['Reply?', 'SKYD draft ready?']);
  const ready = node('SKYD draft ready?', graph);
  assert.equal(ready.parameters.conditions.string[0].operation, 'equal');
  assert.equal(ready.parameters.conditions.string[0].value2, 'DRAFT_READY');
  const claimed = node('SKYD delivery claimed?', graph);
  assert.equal(claimed.parameters.conditions.string[0].operation, 'isNotEmpty');
  assert.equal(evaluate(claimed.parameters.conditions.string[0].value1, {claim_token: TOKEN}), TOKEN);
  assert.equal(evaluate(claimed.parameters.conditions.string[0].value1, {delivery_claimed: false}), undefined);
  const chain = ['SKYD draft ready?', 'Claim SKYD delivery', 'SKYD delivery claimed?', 'Send SKYD draft PDF', 'Record SKYD delivery'];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.deepEqual(graph.connections[chain[i]].main[0].map(edge => edge.node), [chain[i + 1]]);
  }
  assert.equal((graph.connections['SKYD draft ready?'].main[1] || []).length, 0);
  assert.equal((graph.connections['SKYD delivery claimed?'].main[1] || []).length, 0);
});

test('claim and record use the existing scoped header credential and fixed preparation endpoint with redirects and retries off', () => {
  const graph = workflow();
  for (const name of ['Claim SKYD delivery', 'Record SKYD delivery']) {
    const request = node(name, graph);
    assert.equal(request.parameters.method, 'POST');
    assert.equal(request.parameters.url, `${BASE}/skyd-prepare`);
    assert.equal(request.parameters.authentication, 'genericCredentialType');
    assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth');
    assert.deepEqual(request.credentials, node('DGDOC inbox', graph).credentials);
    assert.equal(request.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(request.retryOnFail, false);
  }
  assert.deepEqual(jsonExpression(node('Claim SKYD delivery', graph).parameters.jsonBody, {run_id: RUN}), {action: 'claim_delivery', from: OWNER, run_id: RUN});
});

test('document sending uses only the saved WhatsApp credential, fixed phone ID and owner recipient with a review caption', () => {
  const graph = workflow(), send = node('Send SKYD draft PDF', graph), payload = jsonExpression(send.parameters.jsonBody, claim());
  assert.equal(send.parameters.url, 'https://graph.facebook.com/v21.0/1388023121061452/messages');
  assert.equal(send.parameters.authentication, 'predefinedCredentialType');
  assert.equal(send.parameters.nodeCredentialType, 'whatsAppApi');
  assert.deepEqual(send.credentials, node('WhatsApp reply', graph).credentials);
  assert.equal(send.credentials.httpHeaderAuth, undefined);
  assert.equal(send.retryOnFail, false);
  assert.equal(send.onError, 'continueRegularOutput');
  assert.equal(send.parameters.options.redirect.redirect.followRedirects, false);
  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.to, OWNER);
  assert.equal(payload.type, 'document');
  assert.equal(payload.document.link, claim().download_url);
  assert.equal(payload.document.filename, 'AEXP-C00465-AWB-DRAFT-v1.pdf');
  assert.match(payload.document.caption, /DRAFT.*AEXP-C00465 v1.*Review before use/);
  assert.equal(payload.document.signature, undefined);
});

test('unclaimed, wrong-recipient and cross-domain artifacts never produce a WhatsApp document body', () => {
  const expression = node('Send SKYD draft PDF').parameters.jsonBody;
  const badClaims = [
    claim({to: '971501234567'}), claim({claim_token: ''}),
    claim({download_url: 'https://attacker.example/file.pdf'}),
    claim({download_url: claim().download_url.replace('https:', 'http:')}),
    claim({artifact_path: 'wa-inbox/private.pdf'}),
    claim({download_url: claim().download_url.replace('/v1-', '/v2-')}),
    claim({download_url: 'https://jojtqlfhmkvdegqbwvtj.supabase.co.evil.example/file.pdf'}),
  ];
  for (const candidate of badClaims) assert.throws(() => jsonExpression(expression, candidate), /Invalid SKYD delivery/);
});

test('successful Meta proof is recorded using the exact acquired run and claim, never a response-supplied alternate claim', () => {
  const expression = node('Record SKYD delivery').parameters.jsonBody;
  const recorded = jsonExpression(expression, {messages: [{id: 'wamid.synthetic-valid-id'}], run_id: 'wrong-run', claim_token: 'wrong-token'}, {'Claim SKYD delivery': claim()});
  assert.deepEqual(recorded, {action: 'complete_delivery', from: OWNER, run_id: RUN, claim_token: TOKEN, meta_message_id: 'wamid.synthetic-valid-id'});
});

test('a timeout, HTTP error or empty Meta response records uncertain delivery rather than retrying the send', () => {
  const graph = workflow(), expression = node('Record SKYD delivery', graph).parameters.jsonBody;
  for (const response of [{}, {error: {message: 'timeout'}}, {messages: []}, {messages: [{id: ''}]}, {messages: [{id: 123}]}]) {
    assert.deepEqual(jsonExpression(expression, response, {'Claim SKYD delivery': claim()}), {action: 'fail_delivery', from: OWNER, run_id: RUN, claim_token: TOKEN});
  }
  assert.equal(node('Send SKYD draft PDF', graph).retryOnFail, false);
  assert.equal(node('Send SKYD draft PDF', graph).onError, 'continueRegularOutput');
  assert.equal(graph.connections['Record SKYD delivery'], undefined, 'No loop or automatic resend branch');
});

test('malformed Meta proof also resolves the acquired claim to uncertain instead of leaving it claimed', () => {
  const expression = node('Record SKYD delivery').parameters.jsonBody;
  for (const id of ['   ', 'wamid. invalid', 'x'.repeat(513)]) {
    assert.deepEqual(jsonExpression(expression, {messages: [{id}]}, {'Claim SKYD delivery': claim()}), {action: 'fail_delivery', from: OWNER, run_id: RUN, claim_token: TOKEN});
  }
});

test('five generated delivery nodes contain credential references only and reject applying the extension twice', () => {
  const graph = workflow();
  const added = graph.nodes.filter(item => DELIVERY_NAMES.includes(item.name));
  assert.equal(added.length, 5);
  assert.equal(new Set(added.map(item => item.id)).size, 5);
  for (const item of added) assert.match(item.id, /^[0-9a-f-]{36}$/);
  const text = JSON.stringify(added);
  assert.doesNotMatch(text, /accessToken|clientSecret|apikey|Authorization|Bearer /i);
  assert.throws(() => extendWorkflow(graph), /Unexpected workflow baseline/);
  assert.throws(() => extendWorkflow({nodes: [], connections: {}}), /Unexpected workflow baseline/);
});

test('workflow code keeps delivery separate from intake and generates a clipboard fragment without private payload fixtures', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/build-skyd-workflow.cjs'), 'utf8');
  assert.match(script, /delivery-nodes\.json/);
  assert.match(script, /inbox-url-expression\.txt/);
  assert.match(script, /connections: Object\.fromEntries\(newNodes/);
  assert.doesNotMatch(script, /pinData|binary\.data|\.base64/);
});
