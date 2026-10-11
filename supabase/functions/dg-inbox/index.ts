// v25.11-T  WhatsApp → DGDOC inbox (called by n8n, one call per WhatsApp message)
// Auth: header  x-dg-key  must equal dg_inbox_config.n8n_key  (no JWT — n8n is not a Supabase user)
// Body: { from, name?, type: "text"|"document"|"image", text?, caption?, file?: { name, mime, base64 } }
// Reply: { ok, dg, reply, job_no, files }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-dg-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const OPEN_MIN = 120;                              // files join the sender's job for 2 hours after "DG <job no>"
const JOB_RE = /\b([A-Z]{2,5}-?[A-Z]?\d{3,6})\b/i; // e.g. DGS-C00422
const digits = (s: string) => (s || "").replace(/\D/g, "");
const safe = (s: string) => (s || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);

let KEY: string | null = null;
async function key() {
  if (KEY) return KEY;
  const { data } = await sb.from("dg_inbox_config").select("value").eq("key", "n8n_key").single();
  KEY = data?.value || null; return KEY;
}
function jobFrom(t: string): string | null {
  const s = (t || "").trim();
  if (!/^DG\b/i.test(s)) return null;               // must start with "DG"
  const m = s.replace(/^DG\b[\s:#-]*/i, "").match(JOB_RE);
  return m ? m[1].toUpperCase() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return J({ ok: false, error: "POST only" }, 405);
  const k = await key();
  if (!k || req.headers.get("x-dg-key") !== k) return J({ ok: false, error: "unauthorized" }, 401);
  let b: any; try { b = await req.json(); } catch { return J({ ok: false, error: "bad json" }, 400); }

  const from = digits(b.from);
  if (!from) return J({ ok: false, error: "no sender" }, 400);
  const { data: staff } = await sb.from("dg_staff_numbers").select("name,active").eq("phone", from).maybeSingle();
  const text = String(b.text || b.caption || "");
  if (!staff || !staff.active) {
    // not a DG staff number → not for DGDOC (n8n can pass it to the normal chatbot)
    return J({ ok: true, dg: false, reply: null });
  }
  const who = staff.name || b.name || from;
  const since = new Date(Date.now() - OPEN_MIN * 60000).toISOString();
  const { data: open } = await sb.from("dg_inbox").select("*").eq("sender", from).eq("status", "NEW")
    .gte("updated_at", since).order("updated_at", { ascending: false }).limit(1);
  let row = open && open[0];
  const job = jobFrom(text);

  // "DG <job no>" → start (or continue) that job
  if (job && (!row || (row.job_no && row.job_no !== job))) {
    const { data, error } = await sb.from("dg_inbox").insert({ job_no: job, sender: from, sender_name: who, message: text }).select().single();
    if (error) return J({ ok: false, error: error.message }, 500);
    row = data;
  } else if (job && row && !row.job_no) {
    const { data } = await sb.from("dg_inbox").update({ job_no: job, message: [row.message, text].filter(Boolean).join("\n"), updated_at: new Date().toISOString() }).eq("id", row.id).select().single();
    row = data;
  }

  // attachment
  if (b.file && b.file.base64) {
    if (!row) {
      const { data, error } = await sb.from("dg_inbox").insert({ job_no: null, sender: from, sender_name: who, message: text || null }).select().single();
      if (error) return J({ ok: false, error: error.message }, 500);
      row = data;
    }
    const bytes = Uint8Array.from(atob(b.file.base64), (c) => c.charCodeAt(0));
    const name = safe(b.file.name || (b.type === "image" ? "photo.jpg" : "document.pdf"));
    const path = `wa-inbox/${row.id}/${Date.now()}_${name}`;
    const up = await sb.storage.from("dgdocs").upload(path, bytes, { contentType: b.file.mime || "application/octet-stream", upsert: false });
    if (up.error) return J({ ok: false, error: up.error.message }, 500);
    const files = [...(row.files || []), { path, name: b.file.name || name, mime: b.file.mime || "", size: bytes.length, at: new Date().toISOString() }];
    const { data } = await sb.from("dg_inbox").update({ files, updated_at: new Date().toISOString() }).eq("id", row.id).select().single();
    row = data;
    const n = files.length;
    return J({ ok: true, dg: true, job_no: row.job_no, files: n,
      reply: row.job_no ? `✓ ${row.job_no}: file ${n} received (${b.file.name || name})`
                        : `✓ File received. Now send the job number, e.g.  DG DGS-C00422` });
  }

  if (job) {
    return J({ ok: true, dg: true, job_no: row.job_no, files: (row.files || []).length,
      reply: `✓ JFS DG DESK — job ${row.job_no} opened.\nSend the MAWB / house AWB PDFs, label photos and packing list now.\nThe job will be ready in DGDOC → WHATSAPP INBOX.` });
  }
  if (/^\s*DG\b/i.test(text)) {
    return J({ ok: true, dg: true, reply: "Please send the job number like this:  DG DGS-C00422" });
  }
  // other text from a DG staff number: add it as a note to the open job, no reply
  if (row && text) await sb.from("dg_inbox").update({ message: [row.message, text].filter(Boolean).join("\n"), updated_at: new Date().toISOString() }).eq("id", row.id);
  return J({ ok: true, dg: true, reply: null });
});
