# DGDOC TrackCargo integration

Status on 27 September 2026: the account shows **Pro — Active**, billed monthly for 27 September–27 October. The public Pro price is $19/month with 20 included trackings and $1 per additional tracking. Three shipments already exist from the trial. Six authenticated GET requests succeeded during the controlled API probe. The dashboard still showed **0/20 usage and zero overage** afterward; this observation is not a general guarantee about future retrieval billing.

The client, normalized adapter, authenticated read-only controller, and separate frontend panel are implemented and locally tested. **Production deployment and the deployed browser check are pending.** The successful provider probe verifies API access and the observed response contract; it does not establish that the new DGDOC panel is live.

`TRACKCARGO_API_KEY` and `TRACKCARGO_ORDERS_JSON` are saved in Netlify's server environment. The latter holds the three exact observed AWB/order UUID mappings; real UUIDs are not included in this document. The temporary probe credential file was removed before the GET requests, and the setup's in-memory copy was cleared afterward. The durable secret is stored in Netlify. Never put its value in source files, browser storage, screenshots, logs, or public responses.

## Existing shipment scope

The initial integration is restricted to the following existing shipments. The probe verified each configured order UUID and AWB against the response. Server configuration uses an array of objects with exactly `awb` and `orderId` fields. Canonical, unique mappings are required, with a maximum of five orders; tests use synthetic UUIDs.

| Canonical AWB | Carrier | Verified probe result |
| --- | --- | --- |
| `020-18224861` | Lufthansa Cargo | AVAILABLE; latest actual event RCF at VIE |
| `098-32127141` | Air India | INCONCLUSIVE; pending carrier data |
| `098-32123254` | Air India | INCONCLUSIVE; pending carrier data |

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

For `020-18224861`, RCF at Vienna on 25 September at 00:03 local time becomes **24 September 2026 at 22:03 UTC**, matching the official Lufthansa record. Planned JFK arrival on 27 September at 20:05 local becomes **28 September at 00:05 UTC**. The 16 events include ten actual and six planned events. Future JFK ARR/DLV entries do not establish actual arrival or delivery. Both Air India INCONCLUSIVE records normalize to UNKNOWN with no invented route or events.

The booking event reports 108 pieces while acceptance reports seven. The observed schema does not establish a trustworthy whole-shipment total. Therefore `departedAt` is labelled an **origin departure event**, and full-shipment `arrivedAt` / `deliveredAt` remain null. Individual actual ARR/DLV events retain their reported quantities and event meaning.

## Authenticated read-only controller

`netlify/functions/trackcargo-tracking.mjs` accepts GET only, with no caller-supplied query parameters or order IDs. It reuses Supabase session verification, the exact staff email allowlist, active-profile checks, and saved-company-AWB membership. Authorization and membership are checked on every request, including cache hits. Netlify deploy previews and branch deployments remain disconnected.

The controller reads only configured orders that also exist in saved company AWBs. It makes two provider GETs per selected order, coalesces concurrent reads, and retains successful normalized snapshots in a **60-second process-local memory cache**. The cache is not a shared or durable rate limiter. Provider failures return sanitized per-order errors. There are no database writes, credit reservations, automatic retries, scheduled reads, new orders, subscriptions, cancellations, or webhook configuration.

The frontend provides a separate TrackCargo panel, explicit refresh control, and shipment details. It makes no automatic TrackCargo requests. CargoAi's primary tracking display, reports and manual/legacy history remain unchanged; TrackCargo records are not appended to the existing one-record-per-AWB merge. A pending/error TrackCargo response cannot erase CargoAi or manual history.

## Preserve history and the existing pause

Keep `CARGOAI_LIVE_ENABLED=false` and `CARGOAI_AUTO_SYNC_ENABLED=false`. Do not change CargoAi's existing subscription ledger, credit cap, renewal policy, or signed callback receiver. A TrackCargo read connection must not enable CargoAi's start-tracking controls.

Manual entry timestamps remain recorded-at times rather than verified airline event times. Keep the separate source labels and planned/actual/unknown event distinctions when changing the UI or exports.

Numerical API rate limits, general retrieval usage accounting, and webhook authentication remain unverified. New-order creation and webhooks are not implemented or enabled. Those capabilities require their own verified contracts before use.

## Verification and deployment status

All **27 TrackCargo tests pass**: client 10, adapter 9, controller 8. Tests use synthetic credentials and mocked/redacted data; the separately authorized six-GET probe verifies the real API. The adapter also normalized all three captured probe records successfully without returning raw records publicly.

```text
node --test --test-isolation=none tests/backend/trackcargo-client.test.mjs tests/backend/trackcargo.test.mjs tests/backend/trackcargo-tracking.test.mjs
```

Deployment is still pending at this documentation update. Publish through the normal Netlify function build, then verify unauthenticated access is denied, an allowed active staff session can explicitly refresh the three mapped records, actual/planned UTC times render correctly, and CargoAi sending remains paused. Do not describe the frontend connection as live until that deployed check succeeds.

## Primary references

- [Developer endpoint overview](https://trackcargo.co/developer)
- [OpenAPI reference](https://trackcargo.co/developer/openapi) — the embedded reference rendered blank during inspection; request/response schemas could not be read there.
- [Pricing](https://trackcargo.co/pricing)
- [Supported airlines](https://trackcargo.co/carriers/airlines)
- [Official Lufthansa comparison](https://www.lufthansa-cargo.com/en/eservices/etracking/tracking/-/awb/020/18224861?searchFilter=awb)
