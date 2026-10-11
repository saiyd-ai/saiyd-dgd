export const SKYD_OWNER = '971562977774';
export const SKYD_FIELDS = ['awb','shipper','consignee','origin','destination','pieces','grossWeight','chargeableWeight','goods','dimensions','flight','date','handling','currency','rate','chargesPayment'];
export const SKYD_CORE = ['awb','shipper','consignee','origin','destination','pieces','grossWeight','goods'];
export const SKYD_LIMITS = Object.freeze({ files: 6, fileBytes: 10*1024*1024, totalBytes: 20*1024*1024, textChars: 12000, pdfPages: 3, excelSheets: 4, excelChars: 12000, deadlineMs: 85000 });
const SKYD_TYPES = 'ACCL ACEX ACIM AEXP AIMP AIO ATA BOE CRT DGS DPA ELI ELM GEN LEDT LEXP LIDT LIMP SCCL SCRT SEFC SELC SIFC SILC STR TC WH'.split(' ');
const norm = s => String(s ?? '').replace(/\s+/g,' ').trim().toUpperCase();
export function skydCommand(text){ const m = String(text || '').trim().match(/^SKYD\s+PREPARE\s+([A-Z]{2,5}-C\d{3,8})\s+AWB\s*$/i); return m ? m[1].toUpperCase() : null; }
export function validAwb(value){ const s=String(value ?? ''); if(!/^[\d\s-]+$/.test(s)) return false; const d=s.replace(/\D/g,''); return /^\d{11}$/.test(d) && Number(d.slice(3,10))%7 === Number(d[10]); }
export function skydJobType(snapshot){
  const lines=String(snapshot.note || '').split(/\r?\n/);
  for(let i=lines.length-1;i>=0;i--){ const m=lines[i].match(/^Job type:\s*([A-Z]{2,5})\s*$/i); if(m && SKYD_TYPES.includes(m[1].toUpperCase())) return m[1].toUpperCase(); }
  const m=String(snapshot.job_no || '').match(/^([A-Z]{2,5})-C\d+$/); return m && SKYD_TYPES.includes(m[1]) ? m[1] : null;
}
export function shipmentMessages(text){ return String(text || '').split(/\r?\n/).filter(line => !/^\s*(?:DG\s+[A-Z]{2,5}-?[A-Z]?\d{3,8}|SKYD\s+PREPARE\s+[A-Z]{2,5}-C\d{3,8}\s+AWB)\s*$/i.test(line)).join('\n').trim(); }
export function mentionsDg(text){ const s=String(text || '').replace(/\b(?:NON[-\s]*DANGEROUS GOODS|NOT DANGEROUS GOODS|NON[-\s]*DG|NOT DG)\b/gi,''); return /\b(?:DG|DANGEROUS GOODS|DGD|UN\s*\d{4})\b/i.test(s); }
// Match whole numeric tokens, allowing standard comma groups without confusing
// 2 with 12, decimal fractions, AWB fragments or phone numbers.
function quotedNumbers(quote,value){ return [...quote.matchAll(/(?<![\d.,+\-])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d.,\-])/g)].filter(m=>Number(m[0].replace(/,/g,''))===value); }
function quotedValue(key,quote,value){
  if(['origin','destination','currency','chargesPayment'].includes(key)) return new RegExp('\\b'+String(value)+'\\b','i').test(quote);
  if(typeof value!=='number') return norm(quote).includes(norm(value));
  const tokens=quotedNumbers(quote,value);if(!tokens.length) return false;
  if(['grossWeight','chargeableWeight'].includes(key)) {
    // A number and an unrelated kg somewhere else in the excerpt are not proof
    // of its unit. Require the stated value next to kg/kilogram, or a weight
    // label that explicitly identifies kg before that value.
    return tokens.some(token=>/^\s*(?:KG\b|KGS\b|KILOGRAMS?\b)/i.test(quote.slice(token.index+token[0].length)) ||
      /(?:WEIGHT|WT)\s*\(?\s*(?:KG|KGS|KILOGRAMS?)\s*\)?\s*[:=]?\s*$/i.test(quote.slice(0,token.index)));
  }
  return true;
}
function normalizeField(key,value){
  if(value === null || value === undefined || value === '') return null;
  if(['pieces','grossWeight','chargeableWeight','rate'].includes(key)){
    if(typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'rate' && !value) || (key==='pieces' && !Number.isInteger(value))) return null;
    return value;
  }
  if(typeof value !== 'string' || !value.trim() || value.length>2000) return null;
  const s=value.trim();
  if(key==='awb') return validAwb(s) ? s.replace(/\D/g,'') : null;
  if(['origin','destination','currency'].includes(key)) return /^[A-Z]{3}$/i.test(s) ? s.toUpperCase() : null;
  if(key==='chargesPayment') return ['PREPAID','COLLECT'].includes(s.toUpperCase()) ? s.toUpperCase() : null;
  return s;
}
export function reconcileExtraction(extraction,sources,snapshot){
  const fields={}, evidence={}, warnings=[], missing=[], conflicts=[],acknowledged=new Set();
  const sourceById=new Map(sources.map(s=>[s.id,s]));
  for(const source of Array.isArray(extraction?.sources) ? extraction.sources : []){
    if(!source || typeof source!=='object') continue;
    const original=sourceById.get(source.source_id); if(!original) { warnings.push('An extraction source was not recognized and was ignored.'); continue; }
    acknowledged.add(original.id);
    for(const key of SKYD_FIELDS){
      const item=source.fields?.[key]; if(!item || typeof item!=='object') continue;
      const value=normalizeField(key,item.value), quote=typeof item.excerpt==='string' ? item.excerpt.trim() : '';
      if(value===null) { if(item.value!==null && item.value!==undefined && item.value!=='') warnings.push('Invalid '+key+' was not used.'); continue; }
      if(!quote || quote.length>3000 || !quotedValue(key,quote,item.value)) { warnings.push('Unsupported '+key+' or unit from '+original.id+' was not used.'); continue; }
      const verified=typeof original.text==='string';
      if(verified && !norm(original.text).includes(norm(quote))) { warnings.push('Unsupported '+key+' excerpt from '+original.id+' was not used.'); continue; }
      if(fields[key]!==undefined && norm(fields[key])!==norm(value)) { conflicts.push(key); continue; }
      fields[key]=value; (evidence[key] ||= []).push({source_id:original.id, excerpt:quote, value, text_verified:verified});
    }
  }
  for(const source of sources) if(!acknowledged.has(source.id)) {
    missing.push('unread_source_documents');warnings.push('No extraction evidence record was returned for '+source.id+'. Review the complete originals before requesting a new draft.');
  }
  if(Array.isArray(extraction?.conflicts)) for(const conflict of extraction.conflicts.slice(0,30)) conflicts.push(typeof conflict==='string' ? conflict.slice(0,300) : JSON.stringify(conflict).slice(0,300));
  for(const key of SKYD_CORE) if(fields[key]===undefined) missing.push(key);
  if(conflicts.length){ missing.push('conflicting_source_fields'); warnings.push('Conflicting sources: '+[...new Set(conflicts)].join(', ')); }
  const type=skydJobType(snapshot);
  if(!type) { missing.push('cargo_classification'); warnings.push('Select the job type in the WhatsApp inbox before preparing.'); }
  else if(!['DGS','ELI','ELM'].includes(type) && mentionsDg([shipmentMessages(snapshot.message),fields.handling,fields.goods,...Object.values(evidence).flat().map(e=>e.excerpt)].join('\n'))){
    missing.push('cargo_classification'); warnings.push('Job type '+type+' is General Cargo, but a source mentions DG. Confirm the classification in the inbox before preparing.');
  }
  if(sources.some(s=>!s.text)) warnings.push('PDF/photo excerpts are AI-reported evidence and still require manual review.');
  return {fields,evidence,warnings,missing_fields:[...new Set(missing)],status:missing.length ? 'NEEDS_INPUT' : 'DRAFT_READY'};
}
