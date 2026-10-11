import { MAX_MEDIA_BYTES, mediaSpec, validateMedia } from './media-validation.mjs';

export const OPEN_MIN = 120;
const JOB_RE = /\b([A-Z]{2,5}-?[A-Z]?\d{3,6})\b/i;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-dg-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const digits = value => String(value || '').replace(/\D/g, '');
const safeName = name => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);

export function jobFrom(text) {
  const s = String(text || '').trim();
  if (!/^DG\b/i.test(s)) return null;
  const match = s.replace(/^DG\b[\s:#-]*/i, '').match(JOB_RE);
  return match ? match[1].toUpperCase() : null;
}

function decodeAttachment(file, type) {
  const spec = mediaSpec(file?.mime);
  const name = typeof file?.name === 'string' && file.name.trim() ? file.name.trim() : spec?.defaultName;
  const encoded = file?.base64;
  if (!spec || !['document', 'image'].includes(type) || (type === 'image' && !['jpeg', 'png'].includes(spec.kind)) ||
      typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_MEDIA_BYTES / 3) || encoded.length % 4 ||
      /[^A-Za-z0-9+/=]/.test(encoded) || /=/.test(encoded.slice(0, -2))) throw new Error('Invalid attachment');
  let raw;
  try { raw = atob(encoded); } catch { throw new Error('Invalid attachment'); }
  // Reject noncanonical padding bits, not just decodable base64.
  if (btoa(raw) !== encoded) throw new Error('Invalid attachment');
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  validateMedia(bytes, spec.mime, name);
  return { bytes, name, mime: spec.mime };
}

export function createInboxHandler({ sb, getKey, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  return async req => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return response({ ok: false, error: 'POST only' }, 405);
    const key = await getKey();
    if (!key || req.headers.get('x-dg-key') !== key) return response({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return response({ ok: false, error: 'bad json' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response({ ok: false, error: 'bad json' }, 400);
    const from = digits(body.from);
    if (!from) return response({ ok: false, error: 'no sender' }, 400);
    const { data: staff, error: staffError } = await sb.from('dg_staff_numbers').select('name,active').eq('phone', from).maybeSingle();
    if (staffError) return response({ ok: false, error: 'could not check sender' }, 500);
    if (!staff || !staff.active) return response({ ok: true, dg: false, reply: null });
    const text = typeof body.text === 'string' && body.text ? body.text : (typeof body.caption === 'string' ? body.caption : '');
    if (text.length > 65536 || (typeof body.caption === 'string' && body.caption.length > 65536)) return response({ ok: false, error: 'message too long' }, 400);
    const messageId = typeof body.message_id === 'string' && body.message_id ? body.message_id : null;
    if (messageId && (messageId.length > 512 || /\s/.test(messageId))) return response({ ok: false, error: 'invalid message id' }, 400);
    const job = jobFrom(text);
    if (!job && /^\s*DG\b/i.test(text)) return response({ ok: true, dg: true, reply: 'Please send the job number like this:  DG DGS-C00422' });
    let attachment = null;
    if (body.file !== undefined) {
      try { attachment = decodeAttachment(body.file, body.type); }
      catch { return response({ ok: false, error: 'Unsupported or invalid attachment. Use PDF, XLSX/XLS, JPG/PNG of at most 10 MiB.' }, 400); }
    }
    const time = now(), timestamp = time.toISOString(), since = new Date(time.getTime() - OPEN_MIN * 60000).toISOString();
    const active = () => sb.from('dg_inbox').select('*').eq('sender', from).in('status', ['NEW', 'OPENED']).gte('updated_at', since);
    // Without an explicit job, use the sender's most recently active row. A job
    // command/caption searches only that exact active job, never another job.
    let query = active();
    if (job) query = query.eq('job_no', job);
    let { data: rows, error: readError } = await query.order('updated_at', { ascending: false }).order('created_at', { ascending: false }).limit(1);
    if (readError) return response({ ok: false, error: 'could not find active job' }, 500);
    let row = rows?.[0], created = false;
    if (!row && job) {
      // An attachment/text received before its job command can be assigned later.
      const orphan = await active().is('job_no', null).order('updated_at', { ascending: false }).order('created_at', { ascending: false }).limit(1);
      if (orphan.error) return response({ ok: false, error: 'could not find unassigned job' }, 500);
      row = orphan.data?.[0];
    }
    if (!row && (job || attachment || text.trim())) {
      // Text is appended by the same row-locked RPC as files, including for new
      // rows. A duplicate delivery can therefore never append its caption twice.
      const inserted = await sb.from('dg_inbox').insert({ job_no: job, sender: from, sender_name: staff.name || body.name || from, message: null, updated_at: timestamp }).select().single();
      if (inserted.error) return response({ ok: false, error: 'could not create inbox job' }, 500);
      row = inserted.data; created = true;
    }
    if (!row) return response({ ok: true, dg: true, reply: null });
    let file = null, uploadedPath = null;
    const discardUpload = async () => {
      if (!uploadedPath) return;
      // The append never referenced this object. Cleanup must not change the
      // retry/deduplication response if the storage service is unavailable.
      try { await sb.storage.from('dgdocs').remove([uploadedPath]); } catch { /* best effort */ }
    };
    if (attachment) {
      const path = `wa-inbox/${row.id}/${time.getTime()}_${newId()}_${safeName(attachment.name)}`;
      const uploaded = await sb.storage.from('dgdocs').upload(path, attachment.bytes, { contentType: attachment.mime, upsert: false });
      if (uploaded.error) return response({ ok: false, error: 'could not store attachment' }, 500);
      uploadedPath = path;
      file = { path, name: attachment.name, mime: attachment.mime, size: attachment.bytes.length, at: timestamp };
      if (typeof body.caption === 'string' && body.caption) file.caption = body.caption;
      if (typeof body.message_id === 'string' && body.message_id) file.message_id = body.message_id;
    }
    // The database reads the current files/message after locking this row. Two
    // media requests that downloaded together cannot overwrite each other.
    const appended = await sb.rpc('dg_inbox_append_whatsapp', { p_id: row.id, p_sender: from, p_job_no: job,
      p_text: text || null, p_file: file, p_message_id: messageId, p_at: timestamp });
    if (appended.error || !appended.data?.row) {
      await discardUpload();
      return response({ ok: false, error: 'could not update inbox job' }, 500);
    }
    if (appended.data.duplicate) {
      await discardUpload();
      return response({ ok: true, dg: true, job_no: appended.data.row.job_no, reply: null, duplicate: true });
    }
    row = appended.data.row;
    if (attachment) return response({ ok: true, dg: true, job_no: row.job_no, files: row.files.length,
      reply: row.job_no ? `✓ ${row.job_no}: file ${row.files.length} received (${attachment.name})` : '✓ File received. Now send the job number, e.g.  DG DGS-C00422' });
    if (job) return response({ ok: true, dg: true, job_no: row.job_no, files: (row.files || []).length,
      reply: `✓ JFS DG DESK — job ${row.job_no} opened.\nSend the shipment text, PDFs, Excel files and JPG/PNG photos now.\nThe job will be ready in DGDOC → WHATSAPP INBOX.` });
    return response({ ok: true, dg: true, job_no: row.job_no, reply: created ? '✓ Message received. Now send the job number, e.g.  DG DGS-C00422' : null });
  };
}
