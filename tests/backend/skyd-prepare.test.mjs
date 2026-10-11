import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SKYD_OWNER, SKYD_LIMITS, skydCommand, validAwb, shipmentMessages, reconcileExtraction } from '../../supabase/functions/skyd-prepare/skyd-fields.mjs';
import { SkydInputError, SkydAiError, SKYD_OUTPUT_SCHEMA, parseSkydAiResult, readSkydSources, createSkydPreparation } from '../../supabase/functions/skyd-prepare/skyd-runtime.mjs';
import { createSkydHandler } from '../../supabase/functions/skyd-prepare/skyd-handler.mjs';
const require=createRequire(import.meta.url);
const {PDF,JPEG,PNG,workbookZip,workbookCfb}=require('../helpers/whatsapp-media-fixtures.cjs');
const KEY='synthetic-key-for-test-only', NOW='2026-10-11T12:00:00.000Z';
const INBOX='10000000-0000-4000-8000-000000000001';
const FIELDS={awb:'176-12345675',shipper:'Synthetic Shipper\nDubai UAE',consignee:'Synthetic Consignee\nLondon UK',origin:'DXB',destination:'LHR',pieces:12,grossWeight:10284,goods:'GENERAL MACHINE PARTS'};
const TEXT=Object.entries(FIELDS).map(([key,value])=>key+': '+value+(key==='grossWeight'?' KG':'')).join('\n');
const extract=(fields=FIELDS,id='messages',text=TEXT)=>({sources:[{source_id:id,fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,excerpt:key+': '+value+(key==='grossWeight'?' KG':'')}]))}],conflicts:[]});
const snapshot=(changes={})=>({inbox_id:INBOX,job_no:'AEXP-C00465',message:'DG AEXP-C00465\n'+TEXT,files:[],note:'Job type: AEXP',...changes});
const ready=()=>reconcileExtraction(extract(),[{id:'messages',text:TEXT}],snapshot());
const attachment=(kind,changes={})=>({path:'wa-inbox/'+INBOX+'/synthetic.'+kind,name:'synthetic.'+kind,mime:{pdf:'application/pdf',jpg:'image/jpeg',png:'image/png',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel'}[kind],...changes});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup(options={}){
  const inboxes=structuredClone(options.inboxes || [{id:INBOX,sender:SKYD_OWNER,job_no:'AEXP-C00465',status:'OPENED',message:TEXT,files:[],note:'Job type: AEXP'}]);
  const runs=[],uploads=new Map(),calls={rpc:[],prepare:[],render:[],signed:[]},locks=new Map();
  async function lock(key,fn){const prev=locks.get(key)||Promise.resolve();let unlock;const current=new Promise(resolve=>unlock=resolve);locks.set(key,current);await prev;try{await tick();return await fn();}finally{unlock();}}
  class Query{
    constructor(table){this.table=table;this.filters=[];}
    select(){return this;} eq(key,value){this.filters.push([key,value]);return this;}
    async maybeSingle(){
      if(this.table==='dg_staff_numbers')return {data:options.inactive?null:{active:true},error:options.staffError||null};
      if(this.table==='skyd_awb_runs')return {data:structuredClone(runs.find(row=>this.filters.every(([key,value])=>row[key]===value)))||null,error:null};
      throw new Error('Unexpected table: '+this.table);
    }
  }
  const sb={from:table=>new Query(table),storage:{from:bucket=>{assert.equal(bucket,'dgdocs');return {
    async upload(path,bytes,args){if(options.uploadError)return {error:new Error('private provider upload failure')};assert.equal(args.upsert,false);uploads.set(path,{bytes,args});return {error:null};},
    async createSignedUrl(path,seconds){calls.signed.push({path,seconds});if(options.signError)return {error:new Error('private signing failure')};return {data:{signedUrl:'https://jojtqlfhmkvdegqbwvtj.supabase.co/storage/v1/object/sign/dgdocs/'+path+'?token=synthetic'},error:null};},
  };}},async rpc(name,args){calls.rpc.push({name,args:structuredClone(args)});
    if(name==='skyd_awb_claim_prepare')return lock('sender:'+args.p_sender,async()=>{
      const found=runs.find(row=>row.sender===args.p_sender&&row.request_message_id===args.p_message_id);
      if(found)return {data:found.job_no!==args.p_job_no?{error:'MESSAGE_JOB_MISMATCH'}:{row:structuredClone(found),created:false},error:null};
      const inbox=inboxes.find(row=>row.sender===args.p_sender&&row.job_no===args.p_job_no&&['NEW','OPENED'].includes(row.status));
      if(!inbox)return {data:{error:'JOB_NOT_FOUND'},error:null};
      const row={id:randomUUID(),inbox_id:inbox.id,sender:args.p_sender,job_no:args.p_job_no,request_message_id:args.p_message_id,version:Math.max(0,...runs.filter(r=>r.job_no===args.p_job_no).map(r=>r.version))+1,
        source_snapshot:structuredClone({inbox_id:inbox.id,job_no:inbox.job_no,message:inbox.message,files:inbox.files,note:inbox.note,captured_at:args.p_at}),status:'PROCESSING',processing_token:randomUUID(),delivery_status:'NOT_SENT',artifact_path:null,missing_fields:[],warnings:[]};
      runs.push(row);return {data:{row:structuredClone(row),created:true},error:null};
    });
    if(name==='skyd_awb_finish_prepare')return lock(args.p_run_id,async()=>{
      const row=runs.find(r=>r.id===args.p_run_id&&r.processing_token===args.p_token&&r.status==='PROCESSING');
      if(!row)return {error:new Error('Unavailable claim')};
      assert.equal(args.p_status==='DRAFT_READY',args.p_artifact_path!==null,'Only ready runs may have an artifact path');
      Object.assign(row,{status:args.p_status,fields:structuredClone(args.p_fields),evidence:structuredClone(args.p_evidence),warnings:structuredClone(args.p_warnings),missing_fields:structuredClone(args.p_missing_fields),artifact_path:args.p_artifact_path,error_code:args.p_error_code,ai_usage:args.p_ai_usage});
      return {data:{row:structuredClone(row)},error:null};
    });
    if(name==='skyd_awb_claim_delivery')return lock(args.p_run_id,async()=>{
      const row=runs.find(r=>r.id===args.p_run_id&&r.sender===args.p_sender);
      if(!row||row.status!=='DRAFT_READY')return {error:new Error('Not ready')};
      if(row.delivery_status!=='NOT_SENT')return {data:{row:structuredClone(row),claimed:false},error:null};
      row.delivery_status='CLAIMED';row.delivery_claim_token=randomUUID();return {data:{row:structuredClone(row),claimed:true},error:null};
    });
    if(name==='skyd_awb_finish_delivery')return lock(args.p_run_id,async()=>{
      const row=runs.find(r=>r.id===args.p_run_id&&r.sender===args.p_sender&&r.delivery_claim_token===args.p_token);
      if(!row)return {error:new Error('Unavailable claim')};
      if(row.delivery_status==='SENT'&&row.meta_message_id===args.p_meta_message_id)return {data:{row:structuredClone(row)},error:null};
      if(row.delivery_status!=='CLAIMED')return {error:new Error('Resolved claim')};
      row.delivery_status=args.p_meta_message_id?'SENT':'UNCERTAIN';row.meta_message_id=args.p_meta_message_id;return {data:{row:structuredClone(row)},error:null};
    });
    throw new Error('Unexpected RPC: '+name);
  }};
  const handler=createSkydHandler({sb,getKey:async()=>KEY,now:()=>new Date(NOW),deadlineMs:options.deadlineMs??SKYD_LIMITS.deadlineMs,prepareSnapshot:async(s,signal)=>{calls.prepare.push(structuredClone(s));return options.prepare?options.prepare(s,signal):ready();},
    renderPdf:async(fields,opts)=>{calls.render.push({fields,opts});if(options.render)return options.render(fields,opts);return new Uint8Array(PDF);}});
  async function send(body,options={}){const response=await handler(new Request('https://synthetic.invalid/skyd-prepare',{method:options.method||'POST',headers:{'content-type':'application/json','x-dg-key':options.key??KEY},body:options.method==='GET'?undefined:JSON.stringify({from:SKYD_OWNER,...body})}));return {status:response.status,body:await response.json()};}
  const prepare=(message_id='wamid.synthetic-1',job='AEXP-C00465')=>send({text:'SKYD PREPARE '+job+' AWB',message_id});
  return {sb,inboxes,runs,uploads,calls,send,prepare};
}

test('AWB check digit and exact job command are validated, not corrected silently',()=>{
  assert.equal(validAwb('176-12345675'),true);assert.equal(validAwb('17612345674'),false);assert.equal(validAwb('1761234567'),false);
  assert.equal(validAwb('176-12345675abc'),false);assert.equal(skydCommand('SKYD PREPARE AEXP-C00465 AWB'),'AEXP-C00465');
  assert.equal(skydCommand('SKYD PREPARE AWB'),null);assert.equal(skydCommand('SKYD PREPARE AEXP-C00465 AWB and submit'),null);
});
test('command-only lines are excluded; shipment prose after a job number is preserved',()=>{
  assert.equal(shipmentMessages('DG AEXP-C00465\nDG AEXP-C00465 gross weight 25 KG\nSKYD PREPARE AEXP-C00465 AWB\nGoods: parts'),'DG AEXP-C00465 gross weight 25 KG\nGoods: parts');
});
test('core evidence requires exact source quotations and supports grouped kg numbers',()=>{
  const e=extract();e.sources[0].fields.grossWeight.excerpt='Gross weight: 10,284 KG';
  const s=TEXT.replace('grossWeight: 10284 KG','Gross weight: 10,284 KG');
  const result=reconcileExtraction(e,[{id:'messages',text:s}],snapshot());assert.equal(result.status,'DRAFT_READY');assert.equal(result.fields.grossWeight,10284);assert.equal(result.evidence.grossWeight[0].text_verified,true);
  e.sources[0].fields.grossWeight={value:10284.5,excerpt:'Gross weight: 10,284.500 KG'};
  assert.equal(reconcileExtraction(e,[{id:'messages',text:s+'\nGross weight: 10,284.500 KG'}],snapshot()).fields.grossWeight,10284.5);
  e.sources[0].fields.pieces={value:2,excerpt:'pieces: 12'};
  const mismatch=reconcileExtraction(e,[{id:'messages',text:s}],snapshot());assert.ok(mismatch.missing_fields.includes('pieces'));assert.equal(mismatch.fields.pieces,undefined);
});
test('lb, absent weight units, inferred airport fragments and invalid payments are not used',()=>{
  for(const excerpt of ['grossWeight: 10284 LB','grossWeight: 10284','grossWeight: 10284 LB; package 2 KG']){
    const e=extract();e.sources[0].fields.grossWeight.excerpt=excerpt;
    const r=reconcileExtraction(e,[{id:'messages',text:TEXT+'\n'+excerpt}],snapshot());assert.ok(r.missing_fields.includes('grossWeight'));
  }
  const e=extract();e.sources[0].fields.destination={value:'MIA',excerpt:'Consignee: MIAMI USA'};e.sources[0].fields.chargesPayment={value:'FREE',excerpt:'Payment: FREE'};
  const r=reconcileExtraction(e,[{id:'messages',text:TEXT+'\nConsignee: MIAMI USA\nPayment: FREE'}],snapshot());assert.equal(r.fields.destination,undefined);assert.equal(r.fields.chargesPayment,undefined);
});
test('conflicting sources and invalid AWB prevent a ready draft',()=>{
  const e=extract();e.sources.push({source_id:'file:0',fields:{pieces:{value:13,excerpt:'13 pieces'}}});
  const r=reconcileExtraction(e,[{id:'messages',text:TEXT},{id:'file:0',kind:'image'}],snapshot());assert.equal(r.status,'NEEDS_INPUT');assert.ok(r.missing_fields.includes('conflicting_source_fields'));
  e.sources[0].fields.awb={value:'176-12345674',excerpt:'AWB 176-12345674'};
  assert.ok(reconcileExtraction(e,[{id:'messages',text:TEXT}],snapshot()).missing_fields.includes('awb'));
});
test('a source silently omitted by extraction blocks draft generation',()=>{
  const r=reconcileExtraction(extract(),[{id:'messages',text:TEXT},{id:'file:0',kind:'pdf'}],snapshot());
  assert.equal(r.status,'NEEDS_INPUT');assert.ok(r.missing_fields.includes('unread_source_documents'));
});
test('explicit DG overrides historical job prefix; General Cargo positive DG needs classification',()=>{
  const e=extract(),sources=[{id:'messages',text:TEXT}];
  assert.equal(reconcileExtraction(e,sources,snapshot({message:TEXT+'\nDangerous goods UN 3481'})).status,'NEEDS_INPUT');
  assert.equal(reconcileExtraction(e,sources,snapshot({note:'Job type: DGS',message:TEXT+'\nDangerous goods UN 3481'})).status,'DRAFT_READY');
  assert.equal(reconcileExtraction(e,sources,snapshot({message:TEXT+'\nNON-DANGEROUS GOODS'})).status,'DRAFT_READY');
  assert.equal(reconcileExtraction(e,sources,snapshot({job_no:'TEST-C00001',note:''})).status,'NEEDS_INPUT');
});
test('all admitted original formats are read without discarding an attachment',async()=>{
  const files=['pdf','jpg','png','xlsx','xls'].map(attachment),bytes=[PDF,JPEG,PNG,workbookZip(),workbookCfb()];let i=0;
  const sources=await readSkydSources(snapshot({files}),{download:async()=>bytes[i++],readPdf:async()=>({pages:3}),readExcel:async()=>({sheets:4,text:'Invoice contents'})});
  assert.equal(sources.length,6);assert.deepEqual(sources.slice(1).map(s=>s.kind),['pdf','image','image','excel','excel']);assert.equal(i,5);
});
test('unsupported counts, source sizes, page/text/sheet limits reject instead of truncating',async()=>{
  const base={download:async()=>PDF,readPdf:async()=>({pages:4}),readExcel:async()=>({sheets:5,text:'contents'})};
  await assert.rejects(readSkydSources(snapshot({files:Array.from({length:7},()=>attachment('pdf'))}),base),/At most 6/);
  await assert.rejects(readSkydSources(snapshot({message:'x'.repeat(12001)}),base),/12,000/);
  await assert.rejects(readSkydSources(snapshot({files:[attachment('pdf')]}),base),/more than 3 pages/);
  await assert.rejects(readSkydSources(snapshot({files:[attachment('pdf',{size:10*1024*1024+1})]}),base),/10 MiB/);
  await assert.rejects(readSkydSources(snapshot({files:[attachment('xlsx')]}),{...base,download:async()=>workbookZip()}),/4 sheets/);
  await assert.rejects(readSkydSources(snapshot({files:[attachment('xls')]}),{...base,download:async()=>workbookCfb(),readExcel:async()=>({sheets:1,text:'x'.repeat(12001)})}),/12,000/);
  const large=Buffer.alloc(8*1024*1024);PDF.copy(large);
  await assert.rejects(readSkydSources(snapshot({files:[attachment('pdf'),attachment('pdf'),attachment('pdf')]}),{...base,download:async()=>large,readPdf:async()=>({pages:1})}),/20 MiB/);
});
test('foreign file paths and an aborted download do not reach extraction',async()=>{
  let calls=0;const readers={download:async()=>{calls++;return PDF;},readPdf:async()=>({pages:1}),readExcel:async()=>({sheets:1,text:''})};
  await assert.rejects(readSkydSources(snapshot({files:[attachment('pdf',{path:'wa-inbox/another-job/a.pdf'})]}),readers),/not bound/);assert.equal(calls,0);
  const controller=new AbortController();await assert.rejects(readSkydSources(snapshot({files:[attachment('pdf')]}),{...readers,download:async()=>{controller.abort();return PDF;}},controller.signal),/PREPARE_TIMEOUT/);
});
test('company configured AI model is used and token usage is stored without secrets',async()=>{
  let request;const sb={from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data:{value:{key:'never-output-this-synthetic-key',model:'configured-test-model'}}};}})};
  const prep=createSkydPreparation({sb,fetcher:async(url,opts)=>{request={url,opts};return {ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(extract())}],usage:{input_tokens:123,output_tokens:456,private:'secret'}})};}});
  const result=await prep(snapshot()),requestBody=JSON.parse(request.opts.body);assert.equal(requestBody.model,'configured-test-model');
  assert.deepEqual(requestBody.output_config,{format:{type:'json_schema',schema:SKYD_OUTPUT_SCHEMA}});assert.equal(requestBody.tools,undefined);assert.equal(requestBody.tool_choice,undefined);
  assert.equal(result.ai_usage.input_tokens,123);assert.equal(result.ai_usage.output_tokens,456);assert.equal(result.ai_usage.parse_stage,'accepted');assert.equal(result.ai_usage.stop_reason,'end_turn');assert.deepEqual(result.ai_usage.content_types,['text']);
  assert.equal(JSON.stringify(result).includes('never-output'),false);assert.equal(JSON.stringify(result.ai_usage).includes('secret'),false);
});

test('output schema stays generic and within provider optional/union limits',()=>{
  let optional=0,unions=0;
  function walk(schema){
    if(Array.isArray(schema.type)) unions++;
    if(schema.type==='object'){
      assert.equal(schema.additionalProperties,false);
      optional+=Object.keys(schema.properties).filter(key=>!(schema.required || []).includes(key)).length;
      for(const value of Object.values(schema.properties)) walk(value);
    }
    if(schema.items) walk(schema.items);
  }
  walk(SKYD_OUTPUT_SCHEMA);assert.equal(optional,16);assert.equal(unions,0);
  assert.doesNotMatch(JSON.stringify(SKYD_OUTPUT_SCHEMA),/AEXP-C|SKYD TEST|971562977774/);
  const result=parseSkydAiResult({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(extract())}],usage:{}},'configured-model');
  assert.deepEqual(result.extraction,extract());assert.equal(result.ai_usage.parse_stage,'accepted');
});

test('provider output is parsed exactly and fails closed on prose, fences, wrong shapes and types',()=>{
  const response=text=>({stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:20,output_tokens:40}});
  const json=JSON.stringify(extract());
  for(const text of ['```json\n'+json+'\n```','Here is the shipment: '+json,'{invalid private-source-text}']){
    assert.throws(()=>parseSkydAiResult(response(text),'configured-model'),error=>error instanceof SkydAiError && error.message==='AI_JSON_PARSE' && error.ai_usage.parse_stage==='json_parse' && error.ai_usage.input_tokens===20 && !JSON.stringify(error.ai_usage).includes(text));
  }
  const wrongType=extract();wrongType.sources[0].fields.pieces.value='12';
  const nullField=extract();nullField.sources[0].fields.grossWeight.value=null;
  const unknownField=extract();unknownField.sources[0].fields.signature={value:'approved',excerpt:'approved'};
  for(const value of [{sources:[]},[],{sources:[],conflicts:[],private:'unknown'},wrongType,nullField,unknownField,{sources:[],conflicts:[{private:'customer data'}]}]){
    assert.throws(()=>parseSkydAiResult(response(JSON.stringify(value)),'configured-model'),error=>error.message==='AI_RESULT_SCHEMA' && error.ai_usage.parse_stage==='result_schema');
  }
  const omitted=parseSkydAiResult(response(JSON.stringify({sources:[{source_id:'messages',fields:{}}],conflicts:[]})),'configured-model');
  assert.deepEqual(omitted.extraction.sources[0].fields,{});
  const missing=reconcileExtraction(omitted.extraction,[{id:'messages',text:TEXT}],snapshot());assert.equal(missing.status,'NEEDS_INPUT');assert.ok(missing.missing_fields.includes('awb'));
});

test('refusal, token exhaustion and unexpected stops never become accepted drafts',()=>{
  const text=JSON.stringify(extract());
  for(const [stop,code] of [['refusal','AI_REFUSAL'],['max_tokens','AI_INCOMPLETE'],['tool_use','AI_RESPONSE_STOP'],['private stop value','AI_RESPONSE_STOP']]){
    assert.throws(()=>parseSkydAiResult({stop_reason:stop,content:[{type:'text',text}],usage:{output_tokens:6500}},'configured-model'),error=>error.message===code && error.ai_usage.output_tokens===6500 && !JSON.stringify(error.ai_usage).includes('private stop value'));
  }
  assert.throws(()=>parseSkydAiResult({stop_reason:'end_turn',content:[]},'configured-model'),/AI_EMPTY_RESULT/);
  assert.throws(()=>parseSkydAiResult({stop_reason:'end_turn',content:[{type:'text',text:' '}]},'configured-model'),/AI_EMPTY_RESULT/);
  assert.throws(()=>parseSkydAiResult({stop_reason:'end_turn',content:[{type:'text',text:' '.repeat(100001)}]},'configured-model'),/AI_EMPTY_RESULT/);
  assert.throws(()=>parseSkydAiResult({stop_reason:'end_turn',content:[{type:'text',text:'x'.repeat(100001)}]},'configured-model'),error=>error.message==='AI_RESULT_SCHEMA' && error.ai_usage.parse_stage==='output_limit');
});

test('failed structured parsing preserves only safe private diagnostics and token usage',async()=>{
  const env=setup({prepare:async()=>parseSkydAiResult({stop_reason:'end_turn',content:[{type:'text',text:'private-customer-text not JSON'}],usage:{input_tokens:81,output_tokens:19,private_key:'must-not-store'}},'configured-model')});
  const result=await env.prepare();assert.equal(result.body.status,'FAILED');assert.equal(env.runs[0].error_code,'AI_JSON_PARSE');assert.equal(env.runs[0].ai_usage.parse_stage,'json_parse');assert.equal(env.runs[0].ai_usage.input_tokens,81);
  assert.equal(result.body.ai_usage,undefined);assert.equal(env.uploads.size,0);assert.equal(env.calls.render.length,0);
  assert.doesNotMatch(JSON.stringify(env.runs[0].ai_usage),/private-customer-text|private_key|must-not-store/);assert.doesNotMatch(JSON.stringify(result.body),/private-customer-text|configured-model/);assert.equal(result.body.input_tokens,undefined);
});
test('AI failures never read or expose provider error bodies; truncated output never becomes a draft',async()=>{
  const sb={from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data:{value:{key:'private-test',model:'configured'}}};}})};
  await assert.rejects(createSkydPreparation({sb,fetcher:async()=>({ok:false,json(){throw Error('private body read');},text(){throw Error('private body read');}})})(snapshot()),/AI_REQUEST_FAILED/);
  await assert.rejects(createSkydPreparation({sb,fetcher:async()=>({ok:true,json:async()=>({stop_reason:'max_tokens',content:[]})})})(snapshot()),/AI_INCOMPLETE/);
});
test('download blob size is checked before arrayBuffer allocation',async()=>{
  let allocated=false;const sb={storage:{from:()=>({download:async()=>({data:{size:10*1024*1024+1,arrayBuffer(){allocated=true;throw Error('Must not allocate');}}})})}};
  await assert.rejects(createSkydPreparation({sb})(snapshot({files:[attachment('pdf')]})),/10 MiB/);assert.equal(allocated,false);
});
test('endpoint requires existing shared key, exact owner and active sender',async()=>{
  let env=setup();assert.equal((await env.send({}, {key:'wrong'})).status,401);assert.equal((await env.send({from:'971500000000'})).status,403);assert.equal(env.calls.rpc.length,0);
  env=setup({inactive:true});assert.equal((await env.prepare()).status,403);assert.equal(env.calls.prepare.length,0);
  assert.equal((await setup().send({}, {method:'GET'})).status,405);
});
test('exact job binding rejects missing jobs and commands without a job',async()=>{
  const env=setup();const result=await env.prepare('message-1','AEXP-C00999');assert.equal(result.body.status,'NEEDS_INPUT');assert.equal(env.calls.prepare.length,0);assert.equal(env.runs.length,0);
  assert.match((await env.send({text:'SKYD PREPARE AWB',message_id:'message-2'})).body.reply,/exact command/);assert.equal(env.calls.rpc.length,1);
});
test('concurrent duplicate Meta delivery creates one immutable preparation and one PDF',async()=>{
  const env=setup({prepare:async()=>{await tick();return ready();}});
  const results=await Promise.all([env.prepare(),env.prepare()]);assert.equal(env.runs.length,1);assert.equal(env.calls.prepare.length,1);assert.equal(env.calls.render.length,1);assert.equal(env.uploads.size,1);assert.equal(results.filter(r=>r.body.duplicate).length,1);assert.equal(results.find(r=>r.body.duplicate).body.reply,null);
  assert.equal((await env.prepare()).body.duplicate,true);assert.equal(env.calls.prepare.length,1);
});
test('same message cannot select another job, and new commands create preserved versions',async()=>{
  const env=setup({inboxes:[{id:INBOX,sender:SKYD_OWNER,job_no:'AEXP-C00465',status:'OPENED',message:TEXT,files:[],note:'Job type: AEXP'},{id:randomUUID(),sender:SKYD_OWNER,job_no:'AEXP-C00466',status:'OPENED',message:TEXT,files:[],note:'Job type: AEXP'}]});
  await env.prepare('same-id');assert.equal((await env.prepare('same-id','AEXP-C00466')).body.status,'NEEDS_INPUT');assert.equal(env.calls.prepare.length,1);
  const first=structuredClone(env.runs[0]);env.inboxes[0].message+='\nLater shipment text';await env.prepare('new-id');assert.deepEqual(env.runs.map(r=>r.version),[1,2]);assert.deepEqual(env.runs[0],first);assert.equal(env.runs[0].source_snapshot.message.includes('Later'),false);assert.equal(env.runs[1].source_snapshot.message.includes('Later'),true);
});
test('NEEDS_INPUT never renders/uploads, and preparation outputs never include signed links',async()=>{
  const env=setup({prepare:async()=>({status:'NEEDS_INPUT',fields:{},evidence:{},warnings:['AWB missing'],missing_fields:['awb']})});
  const result=await env.prepare();assert.equal(result.body.status,'NEEDS_INPUT');assert.equal(env.uploads.size,0);assert.equal(env.calls.render.length,0);assert.equal(result.body.artifact_path,null);assert.equal(result.body.download_url,undefined);
});
test('ready draft is private and uniquely version-bound, without touching approved document tables',async()=>{
  const env=setup();const result=await env.prepare();assert.equal(result.body.status,'DRAFT_READY');assert.equal(result.body.download_url,undefined);
  const run=env.runs[0];assert.equal(run.artifact_path,'skyd-awb/'+INBOX+'/v1-'+run.id+'.pdf');assert.equal(env.uploads.get(run.artifact_path).args.contentType,'application/pdf');assert.match(result.body.reply,/not approved, signed or submitted/);
});
test('PDF upload failure records FAILED with no dangling ready artifact',async()=>{
  const env=setup({uploadError:true});const result=await env.prepare();assert.equal(result.status,200);assert.equal(result.body.status,'FAILED');assert.equal(env.runs[0].artifact_path,null);assert.equal(env.runs[0].error_code,'PDF_STORE_FAILED');assert.equal(env.runs[0].status,'FAILED');
});
test('unsupported PDF font requests input and preserves extracted fields/evidence',async()=>{
  const env=setup({render:async()=>{const error=new Error('private text must not leak');error.code='unsupported_awb_pdf_text';throw error;}});
  const result=await env.prepare();assert.equal(result.body.status,'NEEDS_INPUT');assert.ok(result.body.missing_fields.includes('english_awb_fields'));assert.match(result.body.reply,/English or romanized/);assert.equal(env.runs[0].fields.pieces,12);assert.equal(JSON.stringify(result.body).includes('private text'),false);
});
test('unexpected provider exceptions are sanitized and saved as a failed run',async()=>{
  const env=setup({prepare:async()=>{throw new Error('api-key PRIVATE-CUSTOMER-DATA');}});const result=await env.prepare();assert.equal(result.body.status,'FAILED');assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);assert.equal(env.runs[0].error_code,'PREPARE_FAILED');
});
test('an unresponsive source SDK cannot hold the preparation indefinitely or create a late PDF',async()=>{
  let finishSource,signal;const env=setup({deadlineMs:10,prepare:async(s,providedSignal)=>{signal=providedSignal;return new Promise(resolve=>{finishSource=resolve;});}});
  const result=await env.prepare();assert.equal(result.body.status,'FAILED');assert.equal(env.runs[0].error_code,'PREPARE_TIMEOUT');assert.equal(signal.aborted,true);assert.equal(env.calls.render.length,0);
  finishSource(ready());await tick();assert.equal(env.calls.render.length,0);assert.equal(env.uploads.size,0);assert.equal(env.runs[0].status,'FAILED');
});
test('delivery claim is atomic, bound to owner/version and signs one private object for 120 seconds',async()=>{
  const env=setup();await env.prepare();const id=env.runs[0].id;
  const replies=await Promise.all([env.send({action:'claim_delivery',run_id:id}),env.send({action:'claim_delivery',run_id:id})]);
  assert.equal(replies.filter(r=>r.body.delivery_claimed).length,1);const claim=replies.find(r=>r.body.delivery_claimed).body;
  assert.equal(claim.to,SKYD_OWNER);assert.equal(claim.inbox_id,INBOX);assert.equal(claim.version,1);assert.equal(claim.artifact_path,env.runs[0].artifact_path);assert.equal(env.calls.signed.length,1);assert.equal(env.calls.signed[0].seconds,120);assert.match(claim.filename,/AWB-DRAFT-v1/);
  assert.equal((await env.send({action:'complete_delivery',run_id:id,claim_token:claim.claim_token,meta_message_id:'wamid.proof'})).body.delivery_status,'SENT');
  assert.equal((await env.send({action:'complete_delivery',run_id:id,claim_token:claim.claim_token,meta_message_id:'wamid.proof'})).body.delivery_status,'SENT');
  assert.equal((await env.send({action:'claim_delivery',run_id:id})).body.delivery_claimed,false);assert.equal(env.calls.signed.length,1);
});
test('ambiguous send and signed URL failure cannot be automatically retried',async()=>{
  let env=setup();await env.prepare();let id=env.runs[0].id,claim=(await env.send({action:'claim_delivery',run_id:id})).body;
  assert.equal((await env.send({action:'fail_delivery',run_id:id,claim_token:claim.claim_token})).body.delivery_status,'UNCERTAIN');assert.equal((await env.send({action:'claim_delivery',run_id:id})).body.delivery_claimed,false);
  env=setup({signError:true});await env.prepare();id=env.runs[0].id;assert.equal((await env.send({action:'claim_delivery',run_id:id})).status,500);assert.equal(env.runs[0].delivery_status,'UNCERTAIN');assert.equal((await env.send({action:'claim_delivery',run_id:id})).body.delivery_claimed,false);
});
test('delivery proof cannot update another claim or leak drafts to another sender',async()=>{
  const env=setup();await env.prepare();const id=env.runs[0].id;
  assert.equal((await env.send({action:'claim_delivery',run_id:id,from:'971500000000'})).status,403);
  assert.equal((await env.send({action:'complete_delivery',run_id:id,claim_token:randomUUID(),meta_message_id:'wamid.other'})).status,409);
  assert.equal(env.runs[0].delivery_status,'NOT_SENT');assert.equal((await env.send({action:'status',run_id:randomUUID()})).status,404);
});
test('SQL contract locks snapshot/version and delivery claims; only service role can mutate',()=>{
  const sql=fs.readFileSync(new URL('../../supabase/migrations/202610110003_skyd_awb_draft_runs.sql',import.meta.url),'utf8');
  assert.match(sql,/unique\(sender,request_message_id\)/);assert.match(sql,/unique\(sender,job_no,version\)/);assert.match(sql,/pg_advisory_xact_lock/);assert.match(sql,/job_no=p_job_no and status in \('NEW','OPENED'\)/);assert.match(sql,/source_snapshot/);
  const finish=sql.slice(sql.indexOf('create or replace function public.skyd_awb_finish_prepare'),sql.indexOf('create or replace function public.skyd_awb_claim_delivery'));
  assert.doesNotMatch(finish,/set[^;]*source_snapshot=/);assert.match(finish,/r\.inbox_id is null/);assert.match(sql,/where p\.user_id = auth\.uid\(\) and p\.active = true/);
  for(const fn of ['claim_prepare','finish_prepare','claim_delivery','finish_delivery']){assert.match(sql,new RegExp('revoke all on function public\\.skyd_awb_'+fn+'\\([^;]+from public,anon,authenticated;'));assert.match(sql,new RegExp('grant execute on function public\\.skyd_awb_'+fn+'\\([^;]+to service_role;'));}
  assert.match(sql,/if r\.delivery_status<>'NOT_SENT'/);assert.match(sql,/for update/);assert.doesNotMatch(sql,/update public\.jfs_documents|delete from public\.dg_inbox/i);
  const readGrant=sql.match(/grant select\(([^)]+)\)\s+on public\.skyd_awb_runs to authenticated;/)[1];
  assert.match(readGrant,/artifact_path/);assert.doesNotMatch(readGrant,/processing_token|delivery_claim_token|source_snapshot|request_message_id|ai_usage/);assert.doesNotMatch(sql,/grant select on public\.skyd_awb_runs to authenticated/);
});
test('actual delivery response satisfies n8n sending expression and foreign/mismatched links are blocked',async()=>{
  const {extendWorkflow}=require('../../scripts/build-skyd-workflow.cjs');
  const workflow=extendWorkflow({nodes:[{name:'DGDOC inbox',parameters:{options:{}},credentials:{}},{name:'WhatsApp reply',credentials:{}}],connections:{'DGDOC inbox':{main:[[]]}}});
  const expression=workflow.nodes.find(n=>n.name==='Send SKYD draft PDF').parameters.jsonBody;
  const evaluate=new Function('$json','return '+expression.slice(3,-2).trim());
  const env=setup();await env.prepare();const claim=(await env.send({action:'claim_delivery',run_id:env.runs[0].id})).body;
  const sent=JSON.parse(evaluate(claim));assert.equal(sent.to,SKYD_OWNER);assert.equal(sent.document.link,claim.download_url);assert.match(sent.document.caption,/v1/);
  assert.throws(()=>evaluate({...claim,to:'971500000000'}),/Invalid SKYD delivery/);assert.throws(()=>evaluate({...claim,artifact_path:'skyd-awb/another-job.pdf'}),/Invalid SKYD delivery/);
});
test('standalone deployment is reproducible, syntax checked and pins all runtime dependencies',()=>{
  execFileSync(process.execPath,['scripts/build-skyd-prepare.cjs'],{cwd:new URL('../../',import.meta.url)});
  const source=fs.readFileSync(new URL('../../supabase/functions/skyd-prepare/index.ts',import.meta.url),'utf8');
  const js=stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gm,'');new vm.Script(js);
  assert.match(source,/npm:pdf-lib@1\.17\.1/);assert.match(source,/xlsx-0\.20\.3\/package\/xlsx\.mjs/);assert.match(source,/cells>SKYD_LIMITS\.excelChars/);assert.doesNotMatch(source,/ignoreEncryption|sheetRows\s*:|import\(['"]pdf-lib['"]\)/);
});
test('generated entry boots and prepares a real private PDF with injected database/provider',async()=>{
  const pdfLib=await import('pdf-lib');const env=setup();let served,apiRequest;
  const sb={...env.sb,from(table){
    if(table==='dg_inbox_config')return {select(){return this;},eq(){return this;},async single(){return {data:{value:KEY}};}};
    if(table==='company_settings')return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{value:{key:'synthetic-provider-key',model:'configured-model'}}};}};
    return env.sb.from(table);
  }};
  const source=fs.readFileSync(new URL('../../supabase/functions/skyd-prepare/index.ts',import.meta.url),'utf8');
  const js=stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gm,'');
  // Execute in the same realm as PDF-lib: its Array validators use instanceof.
  const provider=async(url,options)=>{apiRequest={url,options};return {ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(extract())}],usage:{input_tokens:100,output_tokens:200}})};};
  new Function('createClient','pdfLib','XLSX','Deno','fetch',js)(()=>sb,pdfLib,{}, {env:{get:()=> 'synthetic-env'},serve(handler){served=handler;}},provider);assert.equal(typeof served,'function');
  const response=await served(new Request('https://synthetic.invalid/skyd-prepare',{method:'POST',headers:{'content-type':'application/json','x-dg-key':KEY},body:JSON.stringify({from:SKYD_OWNER,text:'SKYD PREPARE AEXP-C00465 AWB',message_id:'wamid.generated-entry'})}));
  const result=await response.json();assert.equal(result.status,'DRAFT_READY');assert.equal(JSON.parse(apiRequest.options.body).model,'configured-model');
  const stored=env.uploads.get(result.artifact_path);assert.ok(stored);assert.equal((await pdfLib.PDFDocument.load(stored.bytes)).getPageCount(),1);assert.equal(env.runs[0].ai_usage.input_tokens,100);
});
