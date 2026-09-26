# DGDOC CargoAi tracking setup

Status: the original tracking deployment, database migration, access checks and modern Supabase credentials are complete. CargoCONNECT Bronze is verified ACTIVE with 150 credits for 26 September–26 October 2026; auto-top-up is unchecked. API Key HMAC is saved and verified for Tracking subscription updates, scoped to the `dgdoctracking` key. The additive migration/deployment and the controlled live AWB test remain to be confirmed. **Live tracking has not yet been proven; the first test is limited to 10 credits with auto-sync off.** No secret keys are included in this source. The existing CargoMART PRO subscription is unchanged.

## What this adds

Saved master AWBs from `jfs_joblog`, `jfs_documents` and the existing `jfs_tracking` object are normalized, validated and deduplicated. The existing TRACKING tab is updated with shipment totals, search/filter controls, linked jobs, document approval status, airline shipment status, flight and actual milestone dates. Document Report and its Excel export include shipment status and last tracking update. The tracking view also exports CSV. There is one tracking page in the same DGDOC application.

Existing manual tracking records and raw AWB aliases remain intact. Manual and legacy imported timeline entries are labelled separately from new CargoAi events. Their saved `ts` values are recorded-at times, not proof of an airline's actual departure, arrival or delivery. Invalid or house AWBs remain available for manual history but cannot start CargoAi master-AWB subscriptions. A staff-entered delivery update does not determine CargoAi's subscription status.

Tracking-specific cloud merges retain known history entries per raw AWB key during login, polling and saves. The existing shared store saves a whole object, so read/merge/write cannot guarantee an atomic union if different browsers save simultaneously. This limitation applies to legacy manual history; CargoAi callbacks and credit reservations use the separate transactional database functions.

The browser reads stored tracking records from a Netlify function using the current Supabase session. A separate function subscribes saved AWBs to CargoAi. Authenticated CargoAi callbacks update the database. Refreshing reports makes no CargoAi request. Missing dates stay blank; document DRAFT/CONFIRMED does not determine airline shipment status.

## Plan allowance and activation requirements

The Free account dashboard showed 50 monthly credits. One authorized live pull test returned HTTP 403: Free plans may test only with Mock Airline. No live subscription was created. Free credits therefore do not establish access to real shipment tracking, despite the Track & Trace page showing enabled access.

The active Bronze pilot has 150 monthly credits, with standard subscriptions costing 10 credits per AWB. That covers at most **15 new standard subscriptions** if no credits are used elsewhere. It does not cover the intended 250–300 shipments per month. The user has not selected a higher plan. The purchased plan and scoped HMAC configuration are verified; check the current remaining balance and prove subscription/callback delivery with the controlled test before enabling automatic processing.

The new server configuration has two independent limits: `CARGOAI_PLAN_CREDIT_ALLOWANCE` defaults to 50, and `CARGOAI_MONTHLY_CREDIT_CAP` defaults to 0. The cap must be a nonnegative integer no greater than the allowance; the allowance cannot exceed the application's absolute maximum of 3000. For the verified Bronze pilot, use allowance 150 and an initial test cap of 10, with automatic processing and renewals still off. An allowance change alone never enables live requests or changes a subscription.

The ledger records reserved credits per UTC calendar month, with at most one subscription per sync. CargoAi's billing/reset date may differ: verify the vendor balance and reset date before enabling ongoing processing, especially across a calendar-month boundary. Other API clients' usage is outside this ledger. Reservations are not automatically refunded after errors because a timeout may still have created a billable subscription. The code does not purchase top-ups; the vendor dashboard remains authoritative for usage, entitlements and billing.

## Deployment prerequisites

1. Review the additive upgrade against the deployed source. Both SQL migrations and the old/new regression scripts passed in disposable local PGlite 0.5.8/PostgreSQL 18.3; rollback left zero fixture records. PGlite has a single connection and does not establish concurrent request behaviour. A single selected-AWB test with cap 10 and auto-sync off can proceed after vendor activation; validate two-connection reservation races in a disposable PostgreSQL database before automatic processing.
2. The original migration `202609260001_cargoai_tracking.sql` is already deployed. Apply the new `202609260002_cargoai_plan_allowance.sql` transaction before deploying the updated function. It raises only the ledger's absolute storage ceiling and adds an explicit-allowance claim overload. Existing three-argument callers remain capped at 50; all claim paths retain the same transaction lock, rate gate and reservation ledger. Browser roles still cannot invoke either claim function. No records, plan settings or live flags are changed. Never run either fixture regression script in production.
3. Configure the variables below in Netlify's server/function environment. Never put secret values in `index.html`, `tracking.js`, browser storage, repository files, screenshots, or chat. Do not reuse DGDOC's existing client-side AI-key settings for CargoAi.
4. Deploy through Netlify's normal Git/build pipeline so Functions are bundled. Static drag-and-drop hosting alone does not configure the API integration. Use the same origin as DGDOC for the functions.
5. Test the unauthenticated, authorized, unauthorized, and paused states before enabling CargoAi calls. Keep both live and scheduled processing disabled initially.

## Server environment

| Variable | Value / purpose |
| --- | --- |
| `SUPABASE_URL` | Existing project URL: `https://jojtqlfhmkvdegqbwvtj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Modern `sb_secret_…` server key (preferred), or a legacy `service_role` JWT; keep this existing variable name and restrict it to Netlify function scope |
| `SUPABASE_ANON_KEY` | Set the existing `sb_publishable_…` public project key (preferred), or legacy `anon` key, for user-session verification |
| `TRACKING_ALLOWED_EMAILS` | Comma-separated exact staff email addresses permitted to read/request tracking; no wildcard or domain-wide access. Each user's `profiles.active` must also be `true`. |
| `CARGOAI_API_KEY` | Secret key for the JFS CargoCONNECT organization; create only when authorized |
| `CARGOAI_CALLBACK_URL` | `https://dgdoc.jfslogistics.com/.netlify/functions/cargoai-webhook` after this endpoint is deployed |
| `CARGOAI_WEBHOOK_HMAC_ENABLED` | Default `false`; set `true` after verifying the portal's Tracking subscription updates / API Key HMAC configuration for this key. That portal configuration is now verified; receiving a valid signed callback still needs the controlled test. |
| `CARGOAI_LIVE_ENABLED` | Start `false`; only `true` for the explicitly authorized live test/activation |
| `CARGOAI_AUTO_SYNC_ENABLED` | Start `false`; only `true` after a successful end-to-end test and automatic processing is wanted |
| `CARGOAI_PLAN_CREDIT_ALLOWANCE` | Default `50`; use `150` only after Bronze and its credits are verified. Must be an integer from 0 to 3000; a higher allowance requires a separately verified plan and approval. This does not activate tracking. |
| `CARGOAI_MONTHLY_CREDIT_CAP` | Default `0`; use `10` for one controlled standard-subscription test. Must not exceed the verified plan allowance; account for existing reservations and vendor usage before increasing it. |
| `CARGOAI_ALLOW_RENEWALS` | Start `false`; subscriptions can expire after 21 days and renewal may cost another subscription |

Netlify's hourly scheduled function is production-only and additionally checks the auto-sync, live, HMAC and credit gates. Deploy previews must not receive production secrets or be allowed to send subscriptions. The UI's sync control is unavailable while live requests are paused.

For database REST/RPC calls, a modern `sb_secret_…` key is sent only in the `apikey` header; it is not a JWT and must not be sent as `Authorization: Bearer`. Legacy `service_role` JWTs retain both headers for compatibility. Session verification at `/auth/v1/user` always sends the signed-in user's actual access token as `Authorization: Bearer` and prefers `SUPABASE_ANON_KEY` for `apikey`. This keeps user verification separate from administrative database access.

## Webhook authentication

CargoAi documents HMAC-SHA256 callback signing as **disabled by default**. The current CargoCONNECT portal also provides a self-service setting: **Settings → Callbacks → Callback Authentication → Tracking subscription updates → API Key HMAC**. Scope the setting to the intended API key and save it. The saved row has been verified as Tracking subscription updates / Key: `dgdoctracking` / API Key HMAC. If this setting is unavailable in another account, contact CargoAi for configuration rather than accepting unsigned updates.

The server HMAC flag is an independent gate; it does not configure CargoAi. After the saved portal setting is verified, enable this server gate for the controlled test. The function verifies the Base64 HMAC of the exact request body with the API key, supplied in the `cargoai-api-key` header, using a constant-time comparison. An unsigned callback is rejected rather than treated as shipment evidence. A saved portal setting alone does not prove that a signed callback has reached DGDOC.

The implementation preserves the payload's tracking events, rejects unknown AWBs, handles duplicate payloads, and applies milestone safeguards for planned and split events. Actual arrival must refer to the destination; intermediate hub arrival is not destination arrival. CargoAi/airline coverage and update delays still determine what can be reported.

## Controlled activation check

1. Confirm the intended active staff allowlist and that the webhook endpoint is deployed over HTTPS.
2. Bronze activation and scoped API Key HMAC are verified. Recheck remaining credits and the vendor reset date (the observed period is 26 September–26 October), and retain auto-top-up unchecked. Set allowance `150` and credit cap `10` for the first test; keep auto-sync and renewals off and confirm the current local month has no earlier reservations. Verify the additive migration and updated function deployment before enabling the server HMAC/live gates for this test.
3. Use one valid, current MAWB already saved in DGDOC. A tracking request discloses that MAWB and the callback URL to CargoAi and may consume 10 credits. Do this only when the user has authorized that test. A request for one AWB must match the server's saved records; the server rejects unsaved AWBs and accepts no user-supplied callback URL. A bulk request chooses at most one eligible saved AWB per run; review the saved queue first.
4. Verify one accepted subscription in CargoCONNECT and one corresponding database record. If the request result is ambiguous, inspect the provider before retrying; the code holds the reservation to avoid duplicate charging.
5. Confirm a signed provider callback reaches the server and the same status appears in Shipment Tracking, Document Report and the export. Check planned/split/transit events against the airline timeline before accepting date summaries.
6. Pause new sending after the first test while retaining signed callback reception. Enable hourly auto-sync only after the concurrency check, a successful end-to-end test, and explicit activation. The Bronze allowance covers at most 15 standard subscriptions, not the eventual production volume. Do not raise the allowance to another plan without verifying that plan and obtaining the relevant approval. Free accounts remain limited to vendor-permitted mock tests.

## Verification and rollback

Run `npm test` with a current Node.js runtime, or `node --test --test-isolation=none tests/tracking-ui.test.cjs tests/backend/*.test.mjs` if npm is unavailable. Tests exercise AWB normalization, deduplication, manual-history preservation, request authorization, modern/legacy Supabase key headers, default/paid credit limits, callback authentication, event summaries and CSV safety using fixtures. These tests do not establish production entitlement. After applying both migrations locally, `migration-regression.sql` and `plan-allowance-regression.sql` passed in PGlite: legacy 50-credit behavior, Bronze 150, maximum 3000, invalid allowance/cap pairs, downgrade without ledger reset, duplicate/unknown suppression, callback date corrections and role permissions. Both scripts roll back; use only an empty disposable development database, never production.

Current Node result: all 53 tests passed (24 frontend, 29 backend). A true concurrency check still needs two independent PostgreSQL connections to the same disposable database. Race claims for the same AWB and then different AWBs with a cap of 10; exactly one claim and one 10-credit reservation must succeed in each case. With cap 20, race distinct AWBs to verify the shared 30-second rate gate; after that interval, a second distinct reservation may succeed and a third must be budget-blocked. Include an old three-argument caller racing the new four-argument caller to verify they share the same lock and ledger. Do not use production fixtures or a paid database branch for this check.

The local browser preview uses explicitly labelled sample data, has no live Supabase client, and cannot send CargoAi requests. Preview tooling is outside the deployable source tree.

To pause future subscriptions, set `CARGOAI_LIVE_ENABLED=false` and `CARGOAI_AUTO_SYNC_ENABLED=false` and redeploy functions. Existing vendor subscriptions may continue until their provider-defined completion/expiry; pausing this sender does not cancel them. Keep the signed callback endpoint running if updates for already subscribed AWBs are still needed. A previous Netlify deployment can restore the old frontend without deleting new tracking records.

## Official references

- [Tracking subscription endpoint](https://cargoai.readme.io/reference/tracking-subscription-endpoint-post)
- [Tracking lifecycle](https://cargoai.readme.io/reference/track-and-trace)
- [Callback payload](https://cargoai.readme.io/reference/subscription-e-mail-and-url-updates)
- [Callback HMAC authentication](https://cargoai.readme.io/reference/callbacks-authentication-process)
- [Tracking event codes](https://cargoai.readme.io/reference/tracking-event-codes)
- [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/)
- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
