import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const FREE_CREDIT_CEILING = 50;
export const SUBSCRIPTION_CREDITS = 10;
const PROVIDER_SUBSCRIBE_URL = 'https://api.cargoai.co/solutions/track/subscribe';
const MAX_BODY_BYTES = 512 * 1024;
const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'CANCELED']);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
  });
}

export function errorResponse(error) {
  const status = error instanceof HttpError ? error.status : 503;
  const message = error instanceof HttpError ? error.message : 'Tracking is temporarily unavailable. Please try again later.';
  return json({ ...(status === 503 ? { configured: false, liveEnabled: false, shipments: [] } : {}), error: message, message }, status);
}

function secureUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return url;
  } catch { return null; }
}

export function getConfig(env) {
  const supabase = secureUrl(env.SUPABASE_URL);
  const callback = secureUrl(env.CARGOAI_CALLBACK_URL);
  const allowedEmails = new Set((env.TRACKING_ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)));
  const rawCap = env.CARGOAI_MONTHLY_CREDIT_CAP ?? '0';
  const budget = /^\d+$/.test(rawCap) ? Number(rawCap) : NaN;
  const budgetValid = Number.isSafeInteger(budget) && budget >= 0 && budget <= FREE_CREDIT_CEILING;
  const databaseConfigured = Boolean(supabase && env.SUPABASE_SERVICE_ROLE_KEY && allowedEmails.size);
  const callbackValid = callback && callback.pathname === '/.netlify/functions/cargoai-webhook' && !callback.search;
  const configured = Boolean(databaseConfigured && env.CARGOAI_API_KEY && callbackValid && env.CARGOAI_WEBHOOK_HMAC_ENABLED === 'true' && budgetValid);
  const deploymentAllowed = !env.CONTEXT || env.CONTEXT === 'production';
  const liveEnabled = configured && env.CARGOAI_LIVE_ENABLED === 'true' && deploymentAllowed && budget >= SUBSCRIPTION_CREDITS;
  let message = 'Live tracking is disabled. Saved AWBs can be reviewed without using CargoAi credits.';
  if (!configured) message = 'Tracking setup is incomplete. Live requests are disabled until the server configuration and signed callbacks are ready.';
  if (!budgetValid) message = 'The free credit cap must be an integer from 0 to 50. Live requests are disabled.';
  if (!deploymentAllowed) message = 'Live tracking requests are disabled for deploy previews and branch deployments.';
  if (configured && budget < SUBSCRIPTION_CREDITS) message = 'The application credit cap is below one standard subscription (10 credits). No live requests can be sent.';
  if (liveEnabled) message = `Standard tracking only; the application reserves at most ${budget} credits per UTC calendar month. Existing CargoAi usage must be allowed for in this cap.`;
  return { supabaseUrl: supabase?.origin, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, authKey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, allowedEmails, databaseConfigured, callbackUrl: callbackValid ? callback.href : null, apiKey: env.CARGOAI_API_KEY, hmacEnabled: env.CARGOAI_WEBHOOK_HMAC_ENABLED === 'true', budget, configured, liveEnabled, allowRenewals: env.CARGOAI_ALLOW_RENEWALS === 'true', message };
}

export function normalizeAwb(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  if (!/^[\d\s-]+$/.test(value)) return null;
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(digits) || Number(digits.slice(3, 10)) % 7 !== Number(digits[10])) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function extractSavedAwbs(rows) {
  const found = new Map();
  let invalidCount = 0;
  for (const row of rows) {
    if (!['jfs_joblog', 'jfs_documents', 'jfs_tracking'].includes(row.key)) continue;
    let values = row.value;
    if (typeof values === 'string' && values.length <= 5 * 1024 * 1024) {
      try { values = JSON.parse(values); } catch { values = []; }
    }
    let entries;
    if (row.key === 'jfs_tracking') {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      entries = Object.entries(values).slice(0, 10000).map(([key, value]) => ({ key, value }));
    } else {
      if (!Array.isArray(values)) continue;
      entries = values.slice(0, 10000).map(value => ({ key: null, value }));
    }
    for (const { key, value: entry } of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const raw = entry.awb || entry.snap?.awb || key;
      if (!raw) continue;
      const awb = normalizeAwb(raw);
      if (!awb) { invalidCount++; continue; }
      const timestamp = Math.max(...[entry.ts, entry.last, entry.first, entry.updated].map(v => typeof v === 'number' && Number.isFinite(v) ? v : 0));
      found.set(awb, Math.max(found.get(awb) || 0, timestamp));
    }
  }
  return { awbs: [...found].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([awb]) => awb), invalidCount };
}

export async function readRawBody(request, maxBytes = MAX_BODY_BYTES) {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maxBytes) throw new HttpError(413, 'Request is too large.');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function parseJson(raw) {
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  let nodes = 0;
  const inspect = (value, depth) => {
    if (++nodes > 50000 || depth > 10) throw new HttpError(400, 'Payload structure is too complex.');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length > 2000) throw new HttpError(400, 'Too many events.');
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, 'Unsupported JSON property.');
      inspect(value[key], depth + 1);
    }
  };
  inspect(data, 0);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'An object is required.');
  return data;
}

export function verifySignature(raw, supplied, secret) {
  if (!secret || typeof supplied !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(supplied)) return false;
  const decoded = Buffer.from(supplied, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== supplied) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(decoded, expected);
}

const cleanText = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
const token = (value, max = 40) => typeof value === 'string' && new RegExp(`^[A-Z0-9_-]{1,${max}}$`).test(value) ? value : null;
const airport = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
function date(value) {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,6})?)?(Z|[+-]\d\d:\d\d)$/);
  if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1 || Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] || 0) > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
const numberText = value => (typeof value === 'string' || typeof value === 'number') && /^\d+(?:\.\d+)?$/.test(String(value)) && String(value).length <= 24 ? String(value) : null;

function cleanEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !token(value.code)) return null;
  const f = value.flight && typeof value.flight === 'object' && !Array.isArray(value.flight) ? value.flight : {};
  return {
    code: token(value.code), description: cleanText(value.description, 500), eventDate: date(value.eventDate),
    eventLocation: airport(value.eventLocation), origin: airport(value.origin), destination: airport(value.destination),
    isPlanned: typeof value.isPlanned === 'boolean' ? value.isPlanned : null,
    isPredicted: typeof value.isPredicted === 'boolean' ? value.isPredicted : null,
    isSplit: typeof value.isSplit === 'boolean' ? value.isSplit : null,
    pieces: numberText(value.pieces), weight: numberText(value.weight),
    flightNumber: token(value.flightNumber, 20),
    flight: {
      number: token(f.number, 20), origin: airport(f.origin), destination: airport(f.destination),
      actualDeparture: date(f.actualDeparture), actualArrival: date(f.actualArrival),
      scheduledDeparture: date(f.scheduledDeparture), scheduledArrival: date(f.scheduledArrival),
      estimatedDeparture: date(f.estimatedDeparture), estimatedArrival: date(f.estimatedArrival)
    }
  };
}

export function normalizeTrackingPayload(data, now = new Date()) {
  const awb = normalizeAwb(data.awb);
  if (!awb) throw new HttpError(400, 'Invalid AWB.');
  // All events retain planned/actual flags and partial quantities; do not derive shipment status from the last event.
  const inputEvents = Array.isArray(data.events) ? data.events : [...(Array.isArray(data.oldEvents) ? data.oldEvents : []), ...(Array.isArray(data.newEvents) ? data.newEvents : [])];
  if (inputEvents.length > 2000) throw new HttpError(400, 'Too many events.');
  const events = inputEvents.map(cleanEvent).filter(Boolean);
  const origin = airport(data.origin), destination = airport(data.destination);
  const status = token(data.status, 64);
  // Summary timestamps describe confirmed events for the full quantity only when reported.
  // Partial and unknown-quantity events are still available in the full timeline.
  const totalPieces = numberText(data.pieces);
  const actual = events.filter(e => e.isPlanned === false && e.isPredicted !== true && e.isSplit !== true && totalPieces !== null && e.pieces !== null && Number(e.pieces) >= Number(totalPieces) && Number(totalPieces) > 0);
  const datesFor = (code, location, field) => actual.filter(e => e.code === code && location && e.eventLocation === location).map(e => field ? e.flight[field] || e.eventDate : e.eventDate).filter(d => d && Date.parse(d) <= now.getTime()).sort();
  const departures = datesFor('DEP', origin, 'actualDeparture');
  const arrivals = datesFor('ARR', destination, 'actualArrival');
  const deliveries = status === 'DELIVERED' ? datesFor('DLV', destination) : [];
  const flights = [...new Set(events.filter(e => e.isPlanned === false && e.isPredicted !== true).map(e => e.flight.number || e.flightNumber).filter(Boolean))];
  const confirmedDates = events.filter(e => e.isPlanned === false && e.isPredicted !== true)
    .flatMap(e => [e.eventDate, e.flight.actualDeparture, e.flight.actualArrival])
    .filter(d => d && Date.parse(d) <= now.getTime()).sort();
  return { awb, status, origin, destination, flight: flights.length ? flights.join(', ').slice(0, 240) : null, departedAt: departures[0] || null, arrivedAt: arrivals.at(-1) || null, deliveredAt: deliveries.at(-1) || null, eventWatermark: confirmedDates.at(-1) || null, lastUpdate: now.toISOString(), events, terminal: TERMINAL.has(status), hasEvents: Array.isArray(data.events) || Array.isArray(data.oldEvents) || Array.isArray(data.newEvents) };
}

export class SupabaseStore {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetchImpl = fetchImpl; }
  async request(path, { method = 'GET', body, prefer } = {}) {
    const headers = { apikey: this.config.serviceKey, 'content-type': 'application/json' };
    // Modern secret keys are API keys, not JWTs. Legacy service_role JWTs also use Bearer.
    if (!this.config.serviceKey.startsWith('sb_secret_')) headers.authorization = `Bearer ${this.config.serviceKey}`;
    if (prefer) headers.prefer = prefer;
    const response = await this.fetchImpl(`${this.config.supabaseUrl}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new HttpError(503, 'Tracking storage is unavailable. Complete the tracking database setup first.');
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async activeProfile(userId) {
    const rows = await this.request(`profiles?select=active&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    return Array.isArray(rows) && rows.length === 1 && rows[0].active === true;
  }
  sourceRows() { return this.request('saiyad_shared?select=key,value&key=in.(jfs_joblog,jfs_documents,jfs_tracking)'); }
  async shipments(awbs) {
    const result = [];
    for (let i = 0; i < awbs.length; i += 100) {
      const rows = await this.request(`cargoai_shipments?select=awb,status,origin,destination,flight,departed_at,arrived_at,delivered_at,last_update,events,subscription_status,subscription_expires_at&awb=in.(${awbs.slice(i, i + 100).join(',')})`);
      result.push(...rows);
    }
    return result;
  }
  claim(awb, budget, allowRenewals) { return this.request('rpc/cargoai_claim_subscription', { method: 'POST', body: { p_awb: awb, p_budget: budget, p_allow_renewals: allowRenewals } }); }
  settle(claimToken, accepted) { return this.request('rpc/cargoai_settle_subscription', { method: 'POST', body: { p_claim_token: claimToken, p_accepted: accepted } }); }
  applyWebhook(shipment, hash) { return this.request('rpc/cargoai_apply_webhook', { method: 'POST', body: { p_shipment: shipment, p_payload_hash: hash } }); }
}

export async function authenticate(request, config, store, fetchImpl = fetch) {
  if (!config.databaseConfigured) throw new HttpError(503, 'Tracking access is not configured on this server.');
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 10000) throw new HttpError(401, 'Sign in to view tracking.');
  let response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.authKey, authorization }, redirect: 'error', signal: AbortSignal.timeout(7000) });
  } catch { throw new HttpError(503, 'Sign-in verification is temporarily unavailable.'); }
  if (!response.ok) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const user = await response.json();
  if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id) || typeof user.email !== 'string' || !config.allowedEmails.has(user.email.toLowerCase()) || !await store.activeProfile(user.id)) throw new HttpError(403, 'This account does not have access to company tracking.');
  return user;
}

function toPublicShipment(awb, row, now) {
  let subscriptionStatus = row?.subscription_status || 'not_subscribed';
  if (subscriptionStatus === 'active' && row.subscription_expires_at && Date.parse(row.subscription_expires_at) <= now.getTime()) subscriptionStatus = 'expired';
  return { awb, status: row?.status || 'UNKNOWN', origin: row?.origin || null, destination: row?.destination || null, flight: row?.flight || null, departedAt: row?.departed_at || null, arrivedAt: row?.arrived_at || null, deliveredAt: row?.delivered_at || null, lastUpdate: row?.last_update || null, events: Array.isArray(row?.events) ? row.events : [], subscriptionStatus };
}

export function createTrackingService({ env = process.env, fetchImpl = fetch, store: suppliedStore, now = () => new Date() } = {}) {
  const config = getConfig(env);
  const store = suppliedStore || new SupabaseStore(config, fetchImpl);
  async function saved() { return extractSavedAwbs(await store.sourceRows()); }
  async function list() {
    const { awbs, invalidCount } = await saved();
    const rows = awbs.length ? await store.shipments(awbs) : [];
    const byAwb = new Map(rows.map(row => [row.awb, row]));
    return { configured: config.configured, liveEnabled: config.liveEnabled, shipments: awbs.filter(awb => byAwb.has(awb)).map(awb => toPublicShipment(awb, byAwb.get(awb), now())), message: config.message + (invalidCount ? ` ${invalidCount} saved AWB entries were skipped because their format or check digit is invalid.` : '') };
  }
  async function sync(requestedAwb) {
    let selected = null;
    if (requestedAwb !== undefined) {
      selected = normalizeAwb(requestedAwb);
      if (!selected || selected !== requestedAwb) throw new HttpError(400, 'Select a valid canonical AWB from saved company records.');
    }
    if (!config.liveEnabled && !selected) return { scanned: 0, attempted: 0, accepted: 0, unknown: 0, message: config.message };
    const { awbs } = await saved();
    if (selected && !awbs.includes(selected)) throw new HttpError(404, 'This AWB is not in saved company records. Sync the saved record to the cloud before enabling tracking.');
    if (!config.liveEnabled) return { scanned: selected ? 1 : awbs.length, attempted: 0, accepted: 0, unknown: 0, message: config.message };
    const targets = selected ? [selected] : awbs;
    const result = { scanned: targets.length, attempted: 0, accepted: 0, unknown: 0, message: 'Saved AWBs checked. Existing and unresolved subscriptions are not submitted again.' };
    // One reservation per run bounds execution time and Free-plan request rate, including concurrent callers.
    for (const awb of targets) {
      const claim = await store.claim(awb, config.budget, config.allowRenewals);
      if (claim?.reason === 'budget_exhausted') { result.message = 'The application credit cap has been reached. No further requests were sent.'; break; }
      if (claim?.reason === 'rate_limited') { result.message = 'A tracking request was recently reserved. The next scheduled run will continue.'; break; }
      if (!claim?.claimed || !claim.claimToken) continue;
      result.attempted++;
      let accepted = false;
      try {
        const response = await fetchImpl(PROVIDER_SUBSCRIBE_URL, { method: 'POST', headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ awb, url: config.callbackUrl }), redirect: 'error', signal: AbortSignal.timeout(10000) });
        // HTTP 200 is the documented subscription acknowledgement. Never use retries here.
        if (response.status === 200) {
          const text = await response.text();
          if (text.length <= 65536) {
            const body = JSON.parse(text);
            accepted = Boolean(body && typeof body === 'object' && !Array.isArray(body) && !body.error && !body.errorMessage && !['error', 'failed', 'failure'].includes(String(body.status || '').toLowerCase()));
          }
        }
      } catch { /* Ambiguous delivery consumes the reservation and requires reconciliation. */ }
      await store.settle(claim.claimToken, accepted);
      if (accepted) result.accepted++; else { result.unknown++; result.message = 'A request has an unconfirmed outcome. Its credits remain reserved and it will not be retried automatically.'; }
      break;
    }
    return result;
  }
  return { config, store, list, sync, authenticate: request => authenticate(request, config, store, fetchImpl), async webhook(raw, signature) {
    if (!config.databaseConfigured || !config.hmacEnabled || !config.apiKey) throw new HttpError(503, 'Signed tracking callbacks are not configured.');
    if (!verifySignature(raw, signature, config.apiKey)) throw new HttpError(401, 'Invalid callback signature.');
    const shipment = normalizeTrackingPayload(parseJson(raw), now());
    const result = await store.applyWebhook(shipment, createHash('sha256').update(raw).digest('hex'));
    return { received: true, duplicate: result?.duplicate === true };
  } };
}
