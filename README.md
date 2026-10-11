# SAIYD.AI — Complete DGD Solution

Web app for preparing IATA Dangerous Goods Declarations (DGD), checklists, package stickers,
overpack stickers and DG label guidance — with login, cloud sync and optional AI extraction.
Built for JFS Logistics.

## Stack
- Static site (single `index.html` + `undb.js` UN database + `logo.js` logo) — deploys on Netlify
- Supabase (`saiyd-dgd` project): email/password auth, `profiles` + `saiyad_data` tables with RLS
- Optional Claude API for AI extraction/review (each user adds their own key in Settings)

## Files
- `index.html` — the whole application
- `undb.js`   — built-in UN dangerous goods database (98 entries)
- `logo.js`   — logo as data URI (replace with real logo base64 anytime)
- `netlify.toml` — publish config (in repo root: `publish = "saiyd-site"`, or `.` if repo root is this folder)

## Deploy
Netlify → drag-drop this folder, or connect the GitHub repo (saiyd-ai) and set publish dir.

## Subscription control
Supabase → Table editor → `profiles`: set `active = false` to suspend a user, `plan` text is shown in the app.

## CargoAi shipment tracking

The integration updates the existing TRACKING page with shipment status reporting for saved master air waybills. Its layout includes shipment totals, filters, milestone dates and CSV export. Existing manual timeline records are preserved. Document workflow status (DRAFT / CONFIRMED), staff-recorded updates and CargoAi shipment status remain distinct.

- Valid AWBs are normalized and deduplicated across saved jobs, documents and the existing tracking register without rewriting historical records.
- Netlify functions keep the CargoCONNECT key on the server and store authenticated tracking updates in separate Supabase tables.
- Report views read stored updates. Opening or refreshing a report does not call CargoAi.
- Live subscriptions and scheduled processing are disabled until explicitly configured. The initial development configuration limits this integration to the existing Free account's 50-credit monthly allowance.
- No CargoMART subscription change is part of this code.

See [TRACKING_SETUP.md](TRACKING_SETUP.md) for configuration, verification, and activation requirements. Deployment alone does not establish live CargoAi access.

## WhatsApp inbox intake

Choose the reviewed service type before **Open & Load**: DGS/ELI/ELM open DG Shipment first; the other supported service types open General Cargo. A job-number prefix suggests a type, while an explicit staff selection takes precedence and is saved in the inbox note. Command-only rows wait for documents or substantive shipment messages.

Opening a job attaches its messages and all files without starting AI extraction. Review each document's role (shipment/invoice, master/house AWB, packing list or label), then read one, the selected inputs, or all inputs. Readers run sequentially and display failures, changed fields and missing basic fields. General Cargo extraction stays separate from DG pallet/house state. DG packing inputs are combined per source, and rereading the same source replaces its extracted rows; manual packing-table edits still require review. DG item selection and **Fill DGD** remain explicit staff actions.

Reading is bounded by the existing extractors: shipment PDFs use up to 3 text pages / 1 image page; a single AWB PDF uses up to 5 text pages / 2 image pages; a label PDF uses page 1. AI Excel/text reading uses up to 4 sheets / 12,000 characters. Photo reading needs the configured AI key and readable source images. These actions prepare draft fields, not an approved AWB or DGD.

The inbox accepts shipment text, PDF, XLSX/XLS, and JPG/PNG, including native WhatsApp photos and document attachments. Captions are kept in the job text and file metadata. Messages without a job number are retained in an unassigned inbox row. If no exact active job exists, a later `DG AEXP-C00422` (or another valid job command) assigns the latest active unassigned row. Intake does not itself generate an AWB or DGD.

An active row has status NEW or OPENED and activity within the existing 120-minute window. A plain message/file attaches to the sender's latest active row. A job command or attachment caption containing that command selects the exact active job instead of another named job. The resolver takes a transaction advisory lock per sender before selecting, claiming an unassigned row or creating a row, so simultaneous first messages and identical command/media retries share one canonical active row. Different explicit job commands keep separate jobs. When switching jobs, send the job command and wait for its acknowledgment before sending documents without a job caption; their intended job cannot be inferred when several named jobs are active.

The Edge Function rejects unsupported MIME/extension pairs, mismatched signatures/containers and files over 10 MiB before storage. XLSX checks bounded ZIP headers and workbook entry names, and XLS checks a CFB Workbook/Book directory stream. These checks identify containers; they do not verify the complete workbook, extract its contents or scan for malware. The n8n binary gate repeats the same checks after download. Existing owner, WABA, phone ID, item pairing, Meta attachment URL restriction, credentials and redirect policy remain unchanged.

Deployment order for expanded intake:

1. Run `node scripts/build-whatsapp-intake.cjs` (or `npm run build:whatsapp-intake`) and `npm run test:inbox`.
2. Apply `supabase/migrations/202610110002_dg_inbox_atomic_whatsapp_append.sql` in Supabase before deploying the receiver. Its resolver RPC serializes initial lookup/claim/create per sender. Its append RPC locks the current row, preserves status and note, appends concurrent files/text without replacing a stale JSONB snapshot, and deduplicates WhatsApp message IDs within that row. Execute permission for both RPCs is restricted to the service role. If the append migration was already applied, apply the added resolver definition and grants before deploying the updated receiver.
3. Deploy the generated standalone `supabase/functions/dg-inbox/index.ts`. The existing `dgdocs` bucket already allows these MIME types; the receiver's 10 MiB cap governs this path.
4. Replace only the n8n Parse and Add file Code node bodies with `n8n/parse-owner-message.code.js` and `n8n/add-owner-file.code.js`. Keep the media-ID condition, download URL controls and credentials unchanged; publish the workflow.
5. Verify a job command, then a small PDF, Excel workbook, native photo and text/caption on that job. Check both WhatsApp acknowledgment and the inbox attachments. Also verify a burst of several documents is retained.

Maintained Code node bodies are `n8n/parse-owner-message.js` and `n8n/add-owner-file.js`. Shared admission logic is in `supabase/functions/dg-inbox/media-validation.mjs`, and receiver behavior is in `inbox-handler.mjs`; generated code is rebuilt from these sources. A redundant or failed append upload is removed on a best-effort basis. If storage cleanup fails, an unreferenced object may remain; the handler does not acknowledge a failed append. The resolver prevents new concurrent duplicate rows; it does not merge historical duplicate rows, and chooses the latest active row when historical duplicates exist. Database migration SQL and concurrency are contract-tested locally with atomic mocks; live database validation remains part of deployment verification.

© JFS Logistics / SAIYD.AI
