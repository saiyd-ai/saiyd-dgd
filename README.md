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

© JFS Logistics / SAIYD.AI
