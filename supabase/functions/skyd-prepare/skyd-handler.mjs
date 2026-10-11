import { SKYD_OWNER, SKYD_LIMITS, skydCommand } from './skyd-fields.mjs';
import { SkydInputError, SkydAiError } from './skyd-runtime.mjs';
const SKYD_CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type, x-dg-key','Access-Control-Allow-Methods':'POST, OPTIONS'};
const skydResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...SKYD_CORS}});
const skydUuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function skydPublicRun(run){return {ok:true,run_id:run.id,job_no:run.job_no,status:run.status,version:run.version,artifact_path:run.status==='DRAFT_READY'?run.artifact_path:null,missing_fields:run.missing_fields || [],warnings:run.warnings || []};}
export function createSkydHandler({sb,getKey,prepareSnapshot,renderPdf,now=()=>new Date(),deadlineMs=SKYD_LIMITS.deadlineMs}){
  return async req=>{
    if(req.method==='OPTIONS') return new Response('ok',{headers:SKYD_CORS});
    if(req.method!=='POST') return skydResponse({ok:false,error:'POST only'},405);
    const key=await getKey(); if(!key || req.headers.get('x-dg-key')!==key) return skydResponse({ok:false,error:'unauthorized'},401);
    let body;try{body=await req.json();}catch{return skydResponse({ok:false,error:'bad json'},400);}
    if(!body || typeof body!=='object' || Array.isArray(body)) return skydResponse({ok:false,error:'bad json'},400);
    const from=String(body.from || '').replace(/\D/g,'');
    if(from!==SKYD_OWNER) return skydResponse({ok:false,error:'owner only'},403);
    const staff=await sb.from('dg_staff_numbers').select('active').eq('phone',from).maybeSingle();
    if(staff.error || !staff.data?.active) return skydResponse({ok:false,error:'inactive sender'},403);
    const action=body.action || 'prepare';
    if(action==='prepare'){
      const job=skydCommand(body.text),messageId=body.message_id;
      if(!job) return skydResponse({ok:true,reply:'Send the exact command: SKYD PREPARE AEXP-C00465 AWB',status:'NEEDS_INPUT'});
      if(typeof messageId!=='string' || !messageId || messageId.length>512 || /\s/.test(messageId)) return skydResponse({ok:false,error:'valid message id required'},400);
      const claim=await sb.rpc('skyd_awb_claim_prepare',{p_sender:from,p_job_no:job,p_message_id:messageId,p_at:now().toISOString()});
      if(claim.error) return skydResponse({ok:false,error:'could not claim preparation'},500);
      if(claim.data?.error) return skydResponse({ok:true,status:'NEEDS_INPUT',reply:claim.data.error==='JOB_NOT_FOUND'?'No open inbox job '+job+'. Send DG '+job+' and the shipment documents first.':'This message is already bound to another job. Send a new explicit prepare command.'});
      const run=claim.data?.row; if(!run) return skydResponse({ok:false,error:'could not claim preparation'},500);
      if(!claim.data.created) return skydResponse({...skydPublicRun(run),duplicate:true,reply:null});
      const controller=new AbortController();let rejectDeadline;
      const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
      const timer=setTimeout(()=>{controller.abort();rejectDeadline(new Error('PREPARE_TIMEOUT'));},deadlineMs);
      // Storage SDK downloads may not support AbortSignal. Race the worker
      // deadline too; post-download signal checks prevent late AI work.
      const bounded=promise=>Promise.race([promise,deadline]);
      let result,artifactPath=null,aiUsage={};
      try{
        result=await bounded(prepareSnapshot(run.source_snapshot,controller.signal));
        aiUsage=result.ai_usage || {};
        if(controller.signal.aborted) throw new Error('PREPARE_TIMEOUT');
        if(result.status==='DRAFT_READY'){
          const bytes=await bounded(renderPdf(result.fields,{jobNo:job,version:run.version}));
          if(controller.signal.aborted) throw new Error('PREPARE_TIMEOUT');
          if(!(bytes instanceof Uint8Array) || !bytes.length || bytes.length>SKYD_LIMITS.fileBytes || String.fromCharCode(...bytes.slice(0,5))!=='%PDF-') throw new Error('PDF_FAILED');
          artifactPath='skyd-awb/'+run.inbox_id+'/v'+run.version+'-'+run.id+'.pdf';
          const saved=await bounded(sb.storage.from('dgdocs').upload(artifactPath,bytes,{contentType:'application/pdf',upsert:false}));
          if(saved.error) throw new Error('PDF_STORE_FAILED');
        }
      }catch(error){
        artifactPath=null;
        if(error instanceof SkydAiError) aiUsage=error.ai_usage;
        result=error?.code==='unsupported_awb_pdf_text'?{status:'NEEDS_INPUT',fields:result?.fields || {},evidence:result?.evidence || {},warnings:['Provide English or romanized AWB names, addresses and goods. The original messages remain saved; no characters were silently removed.'],missing_fields:['english_awb_fields']}:
          error instanceof SkydInputError?{status:'NEEDS_INPUT',fields:{},evidence:{},warnings:[error.message],missing_fields:[error.code]}:
          {status:'FAILED',fields:{},evidence:{},warnings:['Preparation failed safely. Check the source documents and company AI configuration, then send a new prepare command.'],missing_fields:[],error_code:controller.signal.aborted?'PREPARE_TIMEOUT':(new Set(['AI_CONFIGURATION','AI_REQUEST_FAILED','AI_INCOMPLETE','AI_INVALID_RESULT','AI_RESPONSE_SHAPE','AI_RESPONSE_STOP','AI_REFUSAL','AI_EMPTY_RESULT','AI_JSON_PARSE','AI_RESULT_SCHEMA','PDF_FAILED','PDF_STORE_FAILED']).has(error?.message)?error.message:'PREPARE_FAILED')};
      }finally{clearTimeout(timer);}
      const finish=await sb.rpc('skyd_awb_finish_prepare',{p_run_id:run.id,p_token:run.processing_token,p_status:result.status,p_fields:result.fields || {},p_evidence:result.evidence || {},
        p_warnings:result.warnings || [],p_missing_fields:result.missing_fields || [],p_artifact_path:artifactPath,p_error_code:result.error_code || null,p_ai_usage:aiUsage});
      if(finish.error || !finish.data?.row) return skydResponse({ok:false,error:'could not record preparation result',run_id:run.id},500);
      const stored=finish.data.row;
      const reply=stored.status==='DRAFT_READY'?'✓ SKYD '+job+' AWB draft v'+stored.version+' prepared. This is a DRAFT for your review; it is not approved, signed or submitted.':
        stored.status==='NEEDS_INPUT'?'SKYD '+job+' needs input: '+(stored.missing_fields || []).join(', ')+'. '+(stored.warnings || []).join(' ') : 'SKYD '+job+' could not prepare a draft. The originals remain saved; ask staff to check this run.';
      return skydResponse({...skydPublicRun(stored),reply});
    }
    if(!skydUuid(body.run_id)) return skydResponse({ok:false,error:'valid run id required'},400);
    if(action==='status'){
      const found=await sb.from('skyd_awb_runs').select('*').eq('id',body.run_id).eq('sender',from).maybeSingle();
      if(found.error || !found.data) return skydResponse({ok:false,error:'run not found'},404);
      return skydResponse({...skydPublicRun(found.data),delivery_status:found.data.delivery_status,reply:null});
    }
    if(action==='claim_delivery'){
      const claim=await sb.rpc('skyd_awb_claim_delivery',{p_run_id:body.run_id,p_sender:from});
      if(claim.error || !claim.data?.row) return skydResponse({ok:false,error:'could not claim delivery'},409);
      if(!claim.data.claimed) return skydResponse({ok:true,run_id:body.run_id,delivery_claimed:false,delivery_status:claim.data.row.delivery_status,reply:null});
      const row=claim.data.row,path='skyd-awb/'+row.inbox_id+'/v'+row.version+'-'+row.id+'.pdf';
      if(row.artifact_path!==path) return skydResponse({ok:false,error:'invalid artifact binding'},500);
      const signed=await sb.storage.from('dgdocs').createSignedUrl(path,120);
      if(signed.error || !signed.data?.signedUrl){
        await sb.rpc('skyd_awb_finish_delivery',{p_run_id:row.id,p_sender:from,p_token:row.delivery_claim_token,p_meta_message_id:null});
        return skydResponse({ok:false,error:'could not prepare private draft delivery'},500);
      }
      return skydResponse({ok:true,run_id:row.id,inbox_id:row.inbox_id,job_no:row.job_no,version:row.version,artifact_path:path,delivery_claimed:true,claim_token:row.delivery_claim_token,download_url:signed.data.signedUrl,
        to:from,recipient:from,filename:row.job_no+'-AWB-DRAFT-v'+row.version+'.pdf',caption:'DRAFT — '+row.job_no+' AWB v'+row.version+'. Review before approval. Not signed or submitted.'});
    }
    if(action==='complete_delivery' || action==='fail_delivery'){
      if(!skydUuid(body.claim_token) || (action==='complete_delivery' && (typeof body.meta_message_id!=='string' || !body.meta_message_id || body.meta_message_id.length>512 || /\s/.test(body.meta_message_id)))) return skydResponse({ok:false,error:'valid delivery proof required'},400);
      const done=await sb.rpc('skyd_awb_finish_delivery',{p_run_id:body.run_id,p_sender:from,p_token:body.claim_token,p_meta_message_id:action==='complete_delivery'?body.meta_message_id:null});
      if(done.error || !done.data?.row) return skydResponse({ok:false,error:'could not record delivery'},409);
      return skydResponse({ok:true,run_id:body.run_id,delivery_status:done.data.row.delivery_status,reply:null});
    }
    return skydResponse({ok:false,error:'unknown action'},400);
  };
}
