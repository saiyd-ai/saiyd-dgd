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

© JFS Logistics / SAIYD.AI
