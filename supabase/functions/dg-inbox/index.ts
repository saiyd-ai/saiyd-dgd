// GENERATED standalone deployment entry; edit media-validation.mjs/inbox-handler.mjs and run scripts/build-whatsapp-intake.cjs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let cachedKey: string | null = null;
async function getKey(){
  if(cachedKey) return cachedKey;
  const { data } = await sb.from("dg_inbox_config").select("value").eq("key", "n8n_key").single();
  cachedKey = data?.value || null;
  return cachedKey;
}

// Shared admission checks for n8n and the inbox endpoint. These identify supported
// signatures/containers; they do not validate document contents or detect malware.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const SPECS = Object.freeze({
  'application/pdf': { kind: 'pdf', extensions: ['pdf'], defaultName: 'document.pdf' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'xlsx', extensions: ['xlsx'], defaultName: 'workbook.xlsx' },
  'application/vnd.ms-excel': { kind: 'xls', extensions: ['xls'], defaultName: 'workbook.xls' },
  'image/jpeg': { kind: 'jpeg', extensions: ['jpg', 'jpeg'], defaultName: 'photo.jpg' },
  'image/png': { kind: 'png', extensions: ['png'], defaultName: 'photo.png' },
});

function mediaSpec(mime) {
  if (typeof mime !== 'string') return null;
  const normalized = mime.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SPECS, normalized)) return null;
  return { mime: normalized, ...SPECS[normalized] };
}

function supportedMediaName(mime, name) {
  const spec = mediaSpec(mime);
  if (!spec || typeof name !== 'string' || !name.trim() || name.length > 512 || /[\x00-\x1f]/.test(name)) return false;
  const extension = name.trim().split('.').at(-1).toLowerCase();
  return spec.extensions.includes(extension);
}

const invalid = () => { throw new Error('Unsupported or invalid attachment.'); };
const starts = (b, signature, offset = 0) => b.length >= offset + signature.length && signature.every((v, i) => b[offset + i] === v);
const ascii = b => Array.from(b, x => String.fromCharCode(x)).join('');
const u16 = (b, p) => (p >= 0 && p + 2 <= b.length) ? b[p] | b[p + 1] << 8 : invalid();
const u32 = (b, p) => (p >= 0 && p + 4 <= b.length) ? (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0 : invalid();

function workbookZip(b) {
  // Read bounded central/local headers, not compressed XML. Workbook entry names
  // are evidence of an OOXML container, not proof that sheets/XML are valid.
  if (!starts(b, [0x50, 0x4b, 3, 4])) invalid();
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (u32(b, p) === 0x06054b50 && p + 22 + u16(b, p + 20) === b.length) { end = p; break; }
  }
  if (end < 0 || u16(b, end + 4) || u16(b, end + 6)) invalid();
  const count = u16(b, end + 10), size = u32(b, end + 12), offset = u32(b, end + 16);
  if (!count || count > 4096 || count !== u16(b, end + 8) || offset + size > end) invalid();
  let p = offset, expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > offset + size || u32(b, p) !== 0x02014b50) invalid();
    const flags = u16(b, p + 8), method = u16(b, p + 10), compressed = u32(b, p + 20), unpacked = u32(b, p + 24);
    const n = u16(b, p + 28), extra = u16(b, p + 30), comment = u16(b, p + 32), local = u32(b, p + 42);
    if ((flags & 1) || ![0, 8].includes(method) || u16(b, p + 34) || !n || n > 4096 || p + 46 + n + extra + comment > offset + size) invalid();
    expanded += unpacked;
    if (unpacked > 32 * 1024 * 1024 || expanded > 64 * 1024 * 1024) invalid();
    const name = ascii(b.subarray(p + 46, p + 46 + n));
    if (names.has(name) || /\\|(^|\/)\.\.(\/|$)/.test(name)) invalid();
    names.add(name);
    if (local + 30 > offset || u32(b, local) !== 0x04034b50 || u16(b, local + 8) !== method || (u16(b, local + 6) & 1)) invalid();
    const ln = u16(b, local + 26), le = u16(b, local + 28);
    if (ln !== n || local + 30 + ln + le + compressed > offset || ascii(b.subarray(local + 30, local + 30 + ln)) !== name) invalid();
    if ((name === '[Content_Types].xml' || name === 'xl/workbook.xml') && (!compressed || !unpacked)) invalid();
    p += 46 + n + extra + comment;
  }
  if (p !== offset + size || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) invalid();
}

function workbookCfb(b) {
  // Follow the bounded CFB FAT directory chain and require a Workbook/Book stream.
  // This excludes ordinary Word/PowerPoint CFB files; BIFF records remain unread.
  if (!starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) || b.length < 512 || u16(b, 28) !== 0xfffe) invalid();
  const major = u16(b, 26), shift = u16(b, 30), sector = 2 ** shift;
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16(b, 32) !== 6 || b.length % sector) invalid();
  const sectors = b.length / sector - 1, fats = [], usedFat = new Set();
  const fatCount = u32(b, 44), difCount = u32(b, 72);
  if (!fatCount || fatCount > sectors || difCount > 32) invalid();
  const addFat = id => { if (id === 0xffffffff) return; if (id >= sectors || usedFat.has(id)) invalid(); usedFat.add(id); fats.push(id); };
  for (let i = 0; i < 109; i++) addFat(u32(b, 76 + i * 4));
  let dif = u32(b, 68);
  const seenDif = new Set();
  for (let i = 0; i < difCount; i++) {
    if (dif >= sectors || seenDif.has(dif)) invalid();
    seenDif.add(dif);
    const start = (dif + 1) * sector;
    for (let p = start; p < start + sector - 4; p += 4) addFat(u32(b, p));
    dif = u32(b, start + sector - 4);
  }
  if (fats.length !== fatCount || (difCount && dif !== 0xfffffffe)) invalid();
  const next = id => {
    const f = fats[Math.floor(id / (sector / 4))];
    if (f === undefined) invalid();
    return u32(b, (f + 1) * sector + id % (sector / 4) * 4);
  };
  let dir = u32(b, 48), found = false;
  const seen = new Set();
  while (dir !== 0xfffffffe) {
    if (dir >= sectors || seen.has(dir) || seen.size >= 4096) invalid();
    seen.add(dir);
    const start = (dir + 1) * sector;
    for (let p = start; p < start + sector; p += 128) {
      if (b[p + 66] !== 2) continue;
      const length = u16(b, p + 64);
      if (length < 2 || length > 64 || length % 2) invalid();
      let name = '';
      for (let j = 0; j < length - 2; j += 2) name += String.fromCharCode(u16(b, p + j));
      if (name === 'Workbook' || name === 'Book') found = true;
      if (name === 'EncryptedPackage' || name === 'EncryptionInfo') invalid();
    }
    dir = next(dir);
  }
  if (!found) invalid();
}

function validateMedia(bytes, mime, name) {
  const spec = mediaSpec(mime);
  if (!spec || !supportedMediaName(spec.mime, name) || !bytes || typeof bytes.length !== 'number' || !bytes.length || bytes.length > MAX_MEDIA_BYTES) invalid();
  const b = bytes;
  if (spec.kind === 'pdf' && !starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) invalid();
  if (spec.kind === 'jpeg' && !starts(b, [0xff, 0xd8, 0xff])) invalid();
  if (spec.kind === 'png' && !starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) invalid();
  if (spec.kind === 'xlsx') workbookZip(b);
  if (spec.kind === 'xls') workbookCfb(b);
  return spec;
}


const OPEN_MIN = 120;
const JOB_RE = /\b([A-Z]{2,5}-?[A-Z]?\d{3,6})\b/i;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-dg-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const digits = value => String(value || '').replace(/\D/g, '');
const safeName = name => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);

function jobFrom(text) {
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

function createInboxHandler({ sb, getKey, now = () => new Date(), newId = () => crypto.randomUUID() }) {
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

Deno.serve(createInboxHandler({ sb, getKey }));
