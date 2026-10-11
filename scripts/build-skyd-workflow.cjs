const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://jojtqlfhmkvdegqbwvtj.supabase.co/functions/v1';
const OWNER = '971562977774';

function extendWorkflow(original) {
  const workflow = structuredClone(original);
  const inbox = workflow.nodes.find(n => n.name === 'DGDOC inbox');
  const whatsapp = workflow.nodes.find(n => n.name === 'WhatsApp reply');
  if (!inbox || !whatsapp || workflow.nodes.some(n => n.name === 'Claim SKYD delivery')) throw new Error('Unexpected workflow baseline');
  inbox.parameters.url = `={{ /^SKYD\\b/i.test(String($json.body?.text || '').trim()) ? '${BASE}/skyd-prepare' : '${BASE}/dg-inbox' }}`;
  inbox.parameters.options = { ...inbox.parameters.options, timeout: 120000 };
  const http = (name, position, jsonBody) => ({
    id: crypto.randomUUID(), name, position, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    parameters: { method: 'POST', url: `${BASE}/skyd-prepare`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody, options: { timeout: 15000, redirect: { redirect: { followRedirects: false } } } },
    credentials: structuredClone(inbox.credentials), retryOnFail: false,
  });
  const condition = (name, position, value1, value2) => ({
    id: crypto.randomUUID(), name, position, type: 'n8n-nodes-base.if', typeVersion: 1,
    parameters: { conditions: { string: [{ value1, operation: value2 ? 'equal' : 'isNotEmpty', ...(value2 ? { value2 } : {}) }] } },
  });
  const ready = condition('SKYD draft ready?', [1536, 608], '={{ $json.status }}', 'DRAFT_READY');
  const claim = http('Claim SKYD delivery', [1760, 592], `={{ JSON.stringify({action:'claim_delivery',from:'${OWNER}',run_id:$json.run_id}) }}`);
  const claimed = condition('SKYD delivery claimed?', [1984, 592], '={{ $json.claim_token }}');
  const send = {
    id: crypto.randomUUID(), name: 'Send SKYD draft PDF', position: [2208, 576], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    parameters: {
      method: 'POST', url: 'https://graph.facebook.com/v21.0/1388023121061452/messages',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'whatsAppApi', sendBody: true, specifyBody: 'json',
      jsonBody: `={{ (() => { const d=$json; const url=d.download_url; if(d.to!=='${OWNER}' || !d.claim_token || typeof url!=='string' || !/^https:\\/\\/jojtqlfhmkvdegqbwvtj\\.supabase\\.co\\/storage\\/v1\\/object\\/sign\\/dgdocs\\/skyd-awb\\/[0-9a-f-]{36}\\/v[1-9]\\d*-[0-9a-f-]{36}\\.pdf\\?token=[A-Za-z0-9._-]+$/.test(url) || url.split('?')[0]!=='https://jojtqlfhmkvdegqbwvtj.supabase.co/storage/v1/object/sign/dgdocs/'+d.artifact_path) throw new Error('Invalid SKYD delivery'); return JSON.stringify({messaging_product:'whatsapp',to:'${OWNER}',type:'document',document:{link:url,filename:d.filename,caption:'SKYD AWB DRAFT - '+d.job_no+' v'+d.version+'. Review before use.'}}); })() }}`,
      options: { timeout: 30000, redirect: { redirect: { followRedirects: false } } },
    },
    credentials: structuredClone(whatsapp.credentials), retryOnFail: false, onError: 'continueRegularOutput',
  };
  const recorded = http('Record SKYD delivery', [2432, 576], `={{ (() => { const d=$('Claim SKYD delivery').item.json; const id=$json.messages?.[0]?.id; const valid=typeof id==='string' && /^wamid\\.[^\\s]{1,505}$/.test(id); return JSON.stringify({action:valid?'complete_delivery':'fail_delivery',from:'${OWNER}',run_id:d.run_id,claim_token:d.claim_token,...(valid?{meta_message_id:id}:{})}); })() }}`);
  workflow.nodes.push(ready, claim, claimed, send, recorded);
  const connect = (source, target) => { workflow.connections[source] = { main: [[{ node: target, type: 'main', index: 0 }]] }; };
  workflow.connections['DGDOC inbox'].main[0].push({ node: ready.name, type: 'main', index: 0 });
  connect(ready.name, claim.name); connect(claim.name, claimed.name); connect(claimed.name, send.name); connect(send.name, recorded.name);
  workflow.settings = { ...workflow.settings, saveExecutionProgress: false };
  return workflow;
}
module.exports = { extendWorkflow };
if (require.main === module) {
  const input = process.argv[2];
  if (!input) throw new Error('Provide exported baseline workflow JSON path');
  const w = extendWorkflow(JSON.parse(fs.readFileSync(input, 'utf8')));
  const out = path.resolve(ROOT, '../../outputs/skyd-whatsapp-awb'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'workflow-review.json'), JSON.stringify(w, null, 2) + '\n');
  const newNodes = w.nodes.filter(n => /^(SKYD draft ready\?|Claim SKYD delivery|SKYD delivery claimed\?|Send SKYD draft PDF|Record SKYD delivery)$/.test(n.name));
  const fragment = { nodes: newNodes, connections: Object.fromEntries(newNodes.filter(n => w.connections[n.name]).map(n => [n.name, w.connections[n.name]])) };
  fs.writeFileSync(path.join(out, 'delivery-nodes.json'), JSON.stringify(fragment, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'inbox-url-expression.txt'), w.nodes.find(n => n.name === 'DGDOC inbox').parameters.url);
  console.log('Prepared SKYD workflow and five delivery nodes; no tokens or execution payloads included.');
}
