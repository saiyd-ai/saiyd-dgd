# DGDOC TrackCargo integration

Status on 27 September 2026: the account shows **Pro — Active**, billed monthly for 27 September–27 October. The public Pro price is $19/month with 20 included trackings and $1 per additional tracking. Three shipments already exist from the trial. Six authenticated GET requests succeeded during the controlled API probe. The dashboard still showed **0/20 usage and zero overage** afterward; this observation is not a general guarantee about future retrieval billing.

The client, normalized adapter, and authenticated read-only controller are deployed. **Initial integration commit `c1876a2` passed the authenticated browser check on 27 September 2026.** An explicit refresh returned one Lufthansa carrier result and two Air India pending results. The six Quick Print controls remained available. The subsequent TrackCargo-only display change replaces the former two-provider presentation; its deployment is recorded separately.

`TRACKCARGO_API_KEY` and `TRACKCARGO_ORDERS_JSON` are saved in Netlify's server environment. The latter holds the three exact observed AWB/order UUID mappings; real UUIDs are not included in this document. The temporary probe credential file was removed before the GET requests, and the setup's in-memory copy was cleared afterward. The durable secret is stored in Netlify. Never put its value in source files, browser storage, screenshots, logs, or public responses.

## Existing shipment scope

The initial integration is restricted to the following existing shipments. The probe verified each configured order UUID and AWB against the response. Server configuration uses an array of objects with exactly `awb` and `orderId` fields. Canonical, unique mappings are required, with a maximum of five orders; tests use synthetic UUIDs.

| Existing order | Carrier | Verified probe result |
| --- | --- | --- |
| Lufthansa test order | Lufthansa Cargo | AVAILABLE; latest actual event RCF at VIE |
| Air India test order A | Air India | INCONCLUSIVE; pending carrier data |
| Air India test order B | Air India | INCONCLUSIVE; pending carrier data |

The live carrier directory listed prefixes 020 and 098. Prefix searches for 147 and 155 returned no match; generic DHL coverage is not evidence of support for 155. No additional tracking order should be created by this integration stage.

## Implemented transport

`netlify/functions/_lib/trackcargo-client.mjs` exports `createTrackCargoClient()` and these methods:

| Method | Provider request |
| --- | --- |
| `getOrder(uuid)` | `GET /api/v1/client-orders/{uuid}` |
| `getTracking(uuid)` | `GET /api/v1/client-orders/{uuid}/tracking` |
| `listAirOrders()` | `GET /api/v1/client-orders/air` |

All requests use the fixed `https://api.trackcargo.co` origin and the server secret in `x-api-key`. The client validates UUID syntax, rejects redirects, limits the complete request to 7 seconds and the response to 512 KiB by default, and emits fixed errors without provider bodies or credentials. Its configurable limits are bounded at 30 seconds and 2 MiB. It performs no automatic retry, pagination, order creation, cancellation, subscription, or webhook configuration.

Successful JSON remains internal to the adapter. The controller never returns raw provider records, organisation identifiers, parties, documents, emissions data, or provider error bodies. `listAirOrders()` is available in the transport but is not used by the report controller.

## Verified adapter and event meaning

`netlify/functions/_lib/trackcargo.mjs` implements `normalizeTrackCargoShipment()` using the observed AVAILABLE and INCONCLUSIVE response shapes. It validates successful envelopes, air mode, non-deleted orders, expected UUID/AWB agreement, and tracking AWB components. Unsupported shapes or mismatched identities fail closed.

The output explicitly identifies `provider: 'trackcargo'`. `orderStatus` describes the provider order, `dataStatus` describes data availability, and `status` is the latest actual carrier event code, not proof of full-shipment completion. `lastUpdate` and `eventWatermark` are that event's UTC time; `fetchedAt` is retrieval time, and `providerUpdatedAt` is separate administrative metadata.

The adapter accepts at most 2,000 events and bounds the exposed fields. An event is actual only when `elapsed === true` and a valid `date_utc_iso.date` is not in the future. If the additional UTC epoch is present, it must agree. `elapsed === false` remains planned, even when its date has passed. Missing or contradictory evidence remains unknown.

**Do not use `date_iso.date` as UTC.** In the observed response it contains local wall time with a misleading `Z`. Only the explicit validated UTC event field drives actual timestamps. Timezone is retained separately; planned arrival and delivery dates are kept separate from actual events.

For the Lufthansa test order, RCF at Vienna on 25 September at 00:03 local time becomes **24 September 2026 at 22:03 UTC**, matching the official Lufthansa record. Planned JFK arrival on 27 September at 20:05 local becomes **28 September at 00:05 UTC**. The 16 events include ten actual and six planned events. Future JFK ARR/DLV entries do not establish actual arrival or delivery. Both Air India INCONCLUSIVE records normalize to UNKNOWN with no invented route or events.

The booking event reports 108 pieces while acceptance reports seven. The observed schema does not establish a trustworthy whole-shipment total. Therefore `departedAt` is labelled an **origin departure event**, and full-shipment `arrivedAt` / `deliveredAt` remain null. Individual actual ARR/DLV events retain their reported quantities and event meaning.

## Authenticated read-only controller

`netlify/functions/trackcargo-tracking.mjs` accepts GET only, with no caller-supplied query parameters or order IDs. It reuses Supabase session verification, the exact staff email allowlist, active-profile checks, and saved-company-AWB membership. Authorization and membership are checked on every request, including cache hits. Netlify deploy previews and branch deployments remain disconnected.

The controller reads only configured orders that also exist in saved company AWBs. It makes two provider GETs per selected order, coalesces concurrent reads, and retains successful normalized snapshots in a **60-second process-local memory cache**. The cache is not a shared or durable rate limiter. Provider failures return sanitized per-order errors. There are no database writes, credit reservations, automatic retries, scheduled reads, new orders, subscriptions, cancellations, or webhook configuration.

The frontend now uses TrackCargo as the only provider in the main shipment table, filters, event counts, details, dashboard/document reports, and CSV export. It joins provider results to local saved AWBs and job metadata; it never falls back to a CargoAi status. AWBs without a retrieved order remain visible and are labelled honestly. Counts measure carrier results and pending results, not whole-shipment delivery inferred from a single event.

Only the explicit **Refresh TrackCargo** button reads provider data. Navigation, cloud updates, visibility changes, and the compatibility `refresh()` method render local/cached data without requesting either tracking provider. The former CargoAi start controls and request path have been removed from the UI. Its backend, credentials, stored records and callback receiver remain untouched. Manual/legacy history remains available separately. The existing three-order read-only scope is unchanged; no new tracking orders or scheduled requests are enabled.

### Retaining the last result across reloads

Successful normalized results are saved in this browser under `dgdoc:trackcargo:snapshot:v1:<Supabase user ID>`. After an active session is available, reloads and new tabs restore that account's snapshot without any provider request. The page, rows, details and exports identify restored results as a **Saved snapshot**, retaining their original retrieval and event times. This browser cache is not company-wide database persistence or an automatic tracking schedule.

The cache contains only an explicit allowlist of normalized shipment/event fields; it excludes API keys, session tokens, provider order UUIDs, raw responses and shipment parties. Validation requires the correct version/user, unique canonical AWBs, UTC timestamps and bounded types, with at most five shipments, 2,000 events per shipment and 2 MiB serialized text. Oversized or malformed data is not restored, and history is never silently truncated. Storage failure leaves the fetched result usable and displays a warning that it could not be saved.

Logout, account changes and authorization rejection clear the previous account's cached result. Missing server configuration removes that saved snapshot. Cross-tab updates restore only the current authenticated account's cache; deletion clears its display. Generation guards prevent a late auth/cache/provider response from replacing data for a newer account or explicit refresh. The cache is ordinary browser storage, not encryption or an authorization boundary; it is excluded from company/cloud synchronization and full-data exports. Existing saved job/document storage is unchanged.

## Preserve history and the existing pause

Keep `CARGOAI_LIVE_ENABLED=false` and `CARGOAI_AUTO_SYNC_ENABLED=false`. Do not change CargoAi's existing subscription ledger, credit cap, renewal policy, or signed callback receiver. A TrackCargo read connection must not enable CargoAi's start-tracking controls.

Manual entry timestamps remain recorded-at times rather than verified airline event times. Keep the separate source labels and planned/actual/unknown event distinctions when changing the UI or exports.

Numerical API rate limits, general retrieval usage accounting, and webhook authentication remain unverified. New-order creation and webhooks are not implemented or enabled. Those capabilities require their own verified contracts before use.

## Verification and deployment status

The TrackCargo display and snapshot revision passes **94 relevant tests**: 38 frontend, 29 preserved CargoAi backend, and 27 TrackCargo backend tests (client 10, adapter 9, controller 8). Frontend checks cover explicit-only reads, source-correct reports/CSV, pending and unlinked AWBs, manual history, reload/new-tab restoration, storage failures, cross-tab synchronization, authentication races and stale-result labels. Tests use synthetic AWBs and credentials with mocked/redacted response shapes; the separately authorized six-GET probe verifies the real API. The adapter also normalized all three captured probe records successfully without returning raw records publicly.

```text
node --test --test-isolation=none tests/backend/trackcargo-client.test.mjs tests/backend/trackcargo.test.mjs tests/backend/trackcargo-tracking.test.mjs
```

The [production deployment](https://app.netlify.com/projects/dgdoc/deploys/6ab82f022ecf4200080dbfa6) is published. An allowed active staff session explicitly refreshed the three mapped records. Actual/planned UTC times rendered separately, CargoAi sending remained paused, and returning to Tracking retained the existing TrackCargo retrieval time without a new request. Authentication rejection and access checks are covered by the controller tests.

## Primary references

- [Developer endpoint overview](https://trackcargo.co/developer)
- [OpenAPI reference](https://trackcargo.co/developer/openapi) — the embedded reference rendered blank during inspection; request/response schemas could not be read there.
- [Pricing](https://trackcargo.co/pricing)
- [Supported airlines](https://trackcargo.co/carriers/airlines)
- [Official Lufthansa tracking](https://www.lufthansa-cargo.com/en/eservices/etracking)
