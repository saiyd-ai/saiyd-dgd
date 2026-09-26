# DGDOC CargoAi tracking setup

Status: implementation prepared for review; **not activated or deployed**. No CargoAi API key is included. The existing CargoMART PRO subscription is unchanged.

## What this adds

Saved master AWBs from `jfs_joblog`, `jfs_documents` and the existing `jfs_tracking` object are normalized, validated and deduplicated. The existing TRACKING tab is updated with shipment totals, search/filter controls, linked jobs, document approval status, airline shipment status, flight and actual milestone dates. Document Report and its Excel export include shipment status and last tracking update. The tracking view also exports CSV. There is one tracking page in the same DGDOC application.

Existing manual tracking records and raw AWB aliases remain intact. Manual and legacy imported timeline entries are labelled separately from new CargoAi events. Their saved `ts` values are recorded-at times, not proof of an airline's actual departure, arrival or delivery. Invalid or house AWBs remain available for manual history but cannot start CargoAi master-AWB subscriptions. A staff-entered delivery update does not determine CargoAi's subscription status.

Tracking-specific cloud merges retain known history entries per raw AWB key during login, polling and saves. The existing shared store saves a whole object, so read/merge/write cannot guarantee an atomic union if different browsers save simultaneously. This limitation applies to legacy manual history; CargoAi callbacks and credit reservations use the separate transactional database functions.

The browser reads stored tracking records from a Netlify function using the current Supabase session. A separate function subscribes saved AWBs to CargoAi. Authenticated CargoAi callbacks update the database. Refreshing reports makes no CargoAi request. Missing dates stay blank; document DRAFT/CONFIRMED does not determine airline shipment status.

## Free-plan limits and unresolved entitlement

The account dashboard showed 50 monthly Free credits and zero used when inspected. A standard tracking subscription was listed as 10 credits per AWB. That allowance would cover at most **five new standard subscriptions per month**, if live tracking is permitted, and cannot cover 250–300 shipments per month.

CargoCONNECT's Plans page described Free as Route & Schedule/Cargo2ZERO and mock-airline access, while its Track & Trace API page showed enabled access on Free with production credit usage. **Live tracking entitlement has not been verified.** Obtain vendor confirmation or perform one permitted test before enabling automatic subscriptions. Do not buy a paid plan or upgrade CargoMART as part of this setup.

The local credit ledger caps this integration at 0–50 reserved credits per UTC calendar month, with at most one subscription per sync. Reservations are not automatically refunded after errors because a timeout may still have created a billable subscription. Other API clients' usage is outside this ledger: keep this key dedicated, check the vendor balance and lower the configured cap accordingly. The vendor dashboard remains authoritative for account usage and entitlements.

## Deployment prerequisites

1. Review the code and SQL migration. The unchanged migration and `tests/backend/migration-regression.sql` passed in a disposable local PGlite 0.5.8/PostgreSQL 18.3 database; transaction rollback left zero fixture records. PGlite has a single connection, so this does not prove concurrent request behaviour on hosted Supabase. Verify the migration and concurrent reservation behaviour in a disposable development database before live activation. Back up the current application and database before applying a production change. Reconcile this downloaded source against the latest `main` before deploying; this update is based on upstream `2c1c35216fa556af9acf8b90c630a97a2639fad3`, which already includes the TRACKING tab.
2. Apply the migration under `supabase/migrations/` to the existing Supabase project. It adds tracking-specific tables and functions. Existing job/document tables are not rewritten. New tracking tables deny direct browser access and are used only through the server service role.
3. Configure the variables below in Netlify's server/function environment. Never put secret values in `index.html`, `tracking.js`, browser storage, repository files, screenshots, or chat. Do not reuse DGDOC's existing client-side AI-key settings for CargoAi.
4. Deploy through Netlify's normal Git/build pipeline so Functions are bundled. Static drag-and-drop hosting alone does not configure the API integration. Use the same origin as DGDOC for the functions.
5. Test the unauthenticated, authorized, unauthorized, and paused states before enabling CargoAi calls. Keep both live and scheduled processing disabled initially.

## Server environment

| Variable | Value / purpose |
| --- | --- |
| `SUPABASE_URL` | Existing project URL: `https://jojtqlfhmkvdegqbwvtj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret server credential for that project; Netlify function scope only |
| `SUPABASE_ANON_KEY` | Optional existing public project key for validating user sessions |
| `TRACKING_ALLOWED_EMAILS` | Comma-separated exact staff email addresses permitted to read/request tracking; no wildcard or domain-wide access. Each user's `profiles.active` must also be `true`. |
| `CARGOAI_API_KEY` | Secret key for the JFS CargoCONNECT organization; create only when authorized |
| `CARGOAI_CALLBACK_URL` | `https://dgdoc.jfslogistics.com/.netlify/functions/cargoai-webhook` after this endpoint is deployed |
| `CARGOAI_WEBHOOK_HMAC_ENABLED` | Keep `false` until CargoAi confirms HMAC signing is activated for this key/account; then `true` |
| `CARGOAI_LIVE_ENABLED` | Start `false`; only `true` for the explicitly authorized live test/activation |
| `CARGOAI_AUTO_SYNC_ENABLED` | Start `false`; only `true` after a successful end-to-end test and automatic processing is wanted |
| `CARGOAI_MONTHLY_CREDIT_CAP` | Start `0`; use `10` for one controlled standard-subscription test, then at most `50` after checking the remaining vendor balance |
| `CARGOAI_ALLOW_RENEWALS` | Start `false`; subscriptions can expire after 21 days and renewal may cost another subscription |

Netlify's hourly scheduled function is production-only and additionally checks the auto-sync, live, HMAC and credit gates. Deploy previews must not receive production secrets or be allowed to send subscriptions. The UI's sync control is unavailable while live requests are paused.

## Webhook authentication

CargoAi documents HMAC-SHA256 callback signing as **disabled by default**. Have CargoAi activate it before enabling live tracking. The function verifies the Base64 HMAC of the exact request body with the API key, supplied in the `cargoai-api-key` header, using a constant-time comparison. An unsigned callback is rejected rather than treated as shipment evidence.

The implementation preserves the payload's tracking events, rejects unknown AWBs, handles duplicate payloads, and applies milestone safeguards for planned and split events. Actual arrival must refer to the destination; intermediate hub arrival is not destination arrival. CargoAi/airline coverage and update delays still determine what can be reported.

## Controlled activation check

1. Confirm the intended active staff allowlist and that the webhook endpoint is deployed over HTTPS.
2. Confirm Free entitlement, remaining credits, and vendor HMAC activation. Keep auto-sync and renewals off. Set the integration credit cap to `10` for the first test.
3. Use one valid, current MAWB already saved in DGDOC. A tracking request discloses that MAWB and the callback URL to CargoAi and may consume 10 credits. Do this only when the user has authorized that test. A request for one AWB must match the server's saved records; the server rejects unsaved AWBs and accepts no user-supplied callback URL. A bulk request chooses at most one eligible saved AWB per run; review the saved queue first.
4. Verify one accepted subscription in CargoCONNECT and one corresponding database record. If the request result is ambiguous, inspect the provider before retrying; the code holds the reservation to avoid duplicate charging.
5. Confirm a signed provider callback reaches the server and the same status appears in Shipment Tracking, Document Report and the export. Check planned/split/transit events against the airline timeline before accepting date summaries.
6. Only then enable hourly auto-sync if requested. The 50-credit ceiling remains a development allowance, not sufficient for production volume. If you remain on Free, leave automatic processing off or limit testing to the vendor-permitted allowance.

## Verification and rollback

Run `npm test` with a current Node.js runtime, or `node --test --test-isolation=none tests/tracking-ui.test.cjs tests/backend/*.test.mjs` if npm is unavailable. All 46 Node tests passed: 22 frontend and 24 backend. Tests exercise AWB normalization, deduplication, manual-history preservation, request authorization, paused/credit-gated flows, callback authentication, event summaries and CSV safety using fixtures. These tests do not establish production entitlement. The separate SQL regression script, including route-correction date resets, was executed successfully in local PGlite as described above. It uses a transaction and rolls its fixture changes back; use only an empty disposable development database, never production.

The local browser preview uses explicitly labelled sample data, has no live Supabase client, and cannot send CargoAi requests. Preview tooling is outside the deployable source tree.

To pause future subscriptions, set `CARGOAI_LIVE_ENABLED=false` and `CARGOAI_AUTO_SYNC_ENABLED=false` and redeploy functions. Existing vendor subscriptions may continue until their provider-defined completion/expiry; pausing this sender does not cancel them. Keep the signed callback endpoint running if updates for already subscribed AWBs are still needed. A previous Netlify deployment can restore the old frontend without deleting new tracking records.

## Official references

- [Tracking subscription endpoint](https://cargoai.readme.io/reference/tracking-subscription-endpoint-post)
- [Tracking lifecycle](https://cargoai.readme.io/reference/track-and-trace)
- [Callback payload](https://cargoai.readme.io/reference/subscription-e-mail-and-url-updates)
- [Callback HMAC authentication](https://cargoai.readme.io/reference/callbacks-authentication-process)
- [Tracking event codes](https://cargoai.readme.io/reference/tracking-event-codes)
- [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/)
