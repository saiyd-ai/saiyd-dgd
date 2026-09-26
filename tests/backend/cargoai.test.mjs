import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authenticate, createTrackingService, extractSavedAwbs, getConfig, normalizeAwb, normalizeTrackingPayload, parseJson, readRawBody, SupabaseStore, verifySignature } from '../../netlify/functions/_lib/cargoai.mjs';
import { makeHandler as trackingHandler } from '../../netlify/functions/cargoai-tracking.mjs';
import { makeHandler as webhookHandler } from '../../netlify/functions/cargoai-webhook.mjs';
import scheduled, { config as scheduleConfig } from '../../netlify/functions/cargoai-scheduled.mjs';

const USER_ID = '01234567-89ab-cdef-0123-456789abcdef';
const env = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  TRACKING_ALLOWED_EMAILS: 'operator@example.com', CARGOAI_API_KEY: 'test-only-secret',
  CARGOAI_CALLBACK_URL: 'https://dgdoc.example.com/.netlify/functions/cargoai-webhook',
  CARGOAI_WEBHOOK_HMAC_ENABLED: 'true', CARGOAI_LIVE_ENABLED: 'true', CARGOAI_MONTHLY_CREDIT_CAP: '50'
};
const awb = serial => `176-${String(serial).padStart(7, '0')}${serial % 7}`;
const authRequest = () => new Request('https://dgdoc.example.com/.netlify/functions/cargoai-tracking', { headers: { authorization: 'Bearer verified.test.token' } });
const sign = raw => createHmac('sha256', env.CARGOAI_API_KEY).update(raw).digest('base64');
const providerResponse = () => new Response(JSON.stringify({ status: 'success' }), { status: 200 });

// A deterministic stand-in for the database RPC contract. The production atomicity is in SQL;
// these tests verify handlers reserve before network calls and never bypass failed claims.
function memoryStore(sourceAwbs = [awb(1)]) {
  const state = { used: 0, claims: new Map(), rows: new Map(), receipts: new Set(), claimCalls: 0, sourceReads: 0 };
  return {
    state,
    async activeProfile() { return true; },
    async sourceRows() { state.sourceReads++; return [{ key: 'jfs_joblog', value: sourceAwbs.map(value => ({ awb: value })) }]; },
    async shipments(awbs) { return awbs.flatMap(value => state.rows.has(value) ? [state.rows.get(value)] : []); },
    async claim(value, budget) {
      state.claimCalls++;
      if (state.claims.has(value)) return { claimed: false, reason: state.claims.get(value).outcome };
      if (state.used + 10 > budget) return { claimed: false, reason: 'budget_exhausted' };
      state.used += 10;
      const id = `claim-${state.claims.size}`;
      state.claims.set(value, { id, outcome: 'pending' });
      state.rows.set(value, { awb: value, subscription_status: 'pending' });
      return { claimed: true, claimToken: id };
    },
    async settle(id, accepted) {
      const [value, claim] = [...state.claims].find(([, c]) => c.id === id);
      claim.outcome = accepted ? 'active' : 'unknown';
      state.rows.get(value).subscription_status = claim.outcome;
    },
    async applyWebhook(shipment, hash) {
      if (state.receipts.has(hash)) return { duplicate: true };
      state.receipts.add(hash);
      state.lastWebhook = shipment;
      return { updated: true };
    }
  };
}

test('AWBs normalize, validate check digits, and reject arbitrary text and numeric coercion', () => {
  assert.equal(normalizeAwb(' 176 00000011 '), awb(1));
  assert.equal(normalizeAwb('17600000011'), awb(1));
  assert.equal(normalizeAwb('176-0000 0011'), awb(1));
  assert.equal(normalizeAwb('176-00000012'), null);
  assert.equal(normalizeAwb('AWB: 176-00000011'), null);
  assert.equal(normalizeAwb('176-00000011https://evil.example'), null);
  assert.equal(normalizeAwb(17600000011), null);
});

test('saved records deduplicate across job log/documents and ignore other data', () => {
  const result = extractSavedAwbs([
    { key: 'jfs_joblog', value: [{ awb: awb(1) }, { awb: 'bad' }] },
    { key: 'jfs_documents', value: JSON.stringify([{ snap: { awb: '17600000011' } }, { awb: awb(2), ts: 10 }]) },
    { key: 'unrelated', value: [{ awb: awb(3) }] }
  ]);
  assert.deepEqual(result, { awbs: [awb(2), awb(1)], invalidCount: 1 });
});

test('existing tracker object contributes valid saved AWBs without changing manual histories', () => {
  const tracker = {
    '176 0000 0011': { awb: awb(1), job: 'JFS-1', updated: 1, milestones: [{ code: 'DLV', ts: 123, src: 'CARGO CONNECT' }] },
    [awb(2)]: { job: 'JFS-2', updated: 20, milestones: [] },
    HOUSE12345678: { awb: 'HOUSE12345678', updated: 30, milestones: [] }
  };
  const before = JSON.stringify(tracker);
  const result = extractSavedAwbs([
    { key: 'jfs_joblog', value: [{ awb: awb(1) }] },
    { key: 'jfs_tracking', value: tracker },
    { key: 'jfs_tracking', value: JSON.stringify({ [awb(2)]: { awb: awb(2) } }) }
  ]);
  assert.deepEqual(result, { awbs: [awb(2), awb(1)], invalidCount: 1 });
  assert.equal(JSON.stringify(tracker), before);
  assert.deepEqual(extractSavedAwbs([{ key: 'jfs_tracking', value: [{ awb: awb(3) }] }]).awbs, []);
});

test('configuration defaults fail closed and cannot raise the 50-credit ceiling', () => {
  assert.equal(getConfig({}).liveEnabled, false);
  assert.equal(getConfig({ ...env, CARGOAI_MONTHLY_CREDIT_CAP: undefined }).budget, 0);
  assert.equal(getConfig({ ...env, CARGOAI_MONTHLY_CREDIT_CAP: undefined }).liveEnabled, false);
  assert.equal(getConfig({ ...env, CONTEXT: 'deploy-preview' }).liveEnabled, false);
  assert.equal(getConfig({ ...env, CONTEXT: 'branch-deploy' }).liveEnabled, false);
  assert.equal(getConfig({ ...env, CARGOAI_LIVE_ENABLED: undefined }).liveEnabled, false);
  assert.equal(getConfig({ ...env, TRACKING_ALLOWED_EMAILS: '' }).databaseConfigured, false);
  for (const value of ['51', '-1', 'NaN', '1.5', 'Infinity']) assert.equal(getConfig({ ...env, CARGOAI_MONTHLY_CREDIT_CAP: value }).liveEnabled, false);
  assert.equal(getConfig({ ...env, CARGOAI_MONTHLY_CREDIT_CAP: '0' }).budget, 0);
  assert.equal(getConfig({ ...env, CARGOAI_WEBHOOK_HMAC_ENABLED: 'false' }).liveEnabled, false);
  for (const url of ['http://dgdoc.example.com/.netlify/functions/cargoai-webhook', 'https://localhost/.netlify/functions/cargoai-webhook', 'https://127.0.0.1/.netlify/functions/cargoai-webhook', 'https://dgdoc.example.com/wrong', 'https://user:pass@dgdoc.example.com/.netlify/functions/cargoai-webhook']) {
    assert.equal(getConfig({ ...env, CARGOAI_CALLBACK_URL: url }).liveEnabled, false);
  }
});

test('authorization verifies Supabase user, exact email allowlist, and active profile', async () => {
  const config = getConfig(env), store = memoryStore();
  let calls = 0;
  const authFetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(options.headers.authorization, 'Bearer verified.test.token');
    return new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' }));
  };
  assert.equal((await authenticate(authRequest(), config, store, authFetch)).id, USER_ID);
  assert.equal(calls, 1);
  await assert.rejects(authenticate(new Request('https://dgdoc.example.com'), config, store, authFetch), e => e.status === 401);
  await assert.rejects(authenticate(authRequest(), getConfig({ ...env, TRACKING_ALLOWED_EMAILS: '' }), store, authFetch), e => e.status === 503);
  await assert.rejects(authenticate(authRequest(), config, { ...store, activeProfile: async () => false }, authFetch), e => e.status === 403);
  await assert.rejects(authenticate(authRequest(), config, store, async () => new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com.evil' }))), e => e.status === 403);
  await assert.rejects(authenticate(authRequest(), config, store, async () => new Response('{}', { status: 401 })), e => e.status === 401);
});

test('GET uses stored company records and never calls CargoAi', async () => {
  const store = memoryStore([awb(1), awb(2)]);
  store.state.rows.set(awb(1), { awb: awb(1), status: 'IN_TRANSIT', subscription_status: 'active' });
  const handler = trackingHandler({ env, store, fetchImpl: async url => {
    assert.equal(url, 'https://example.supabase.co/auth/v1/user');
    return new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' }));
  } });
  const response = await handler(authRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.shipments[0].awb, awb(1));
  assert.equal(body.shipments[0].status, 'IN_TRANSIT');
  assert.equal(body.shipments[0].subscriptionStatus, 'active');
  assert.equal(body.shipments.length, 1);
  assert.equal(store.state.claimCalls, 0);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('incomplete server setup returns a safe empty configuration response', async () => {
  const response = await trackingHandler({ env: {}, fetchImpl: () => assert.fail('No external calls') })(authRequest());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.liveEnabled, false);
  assert.deepEqual(body.shipments, []);
  assert.equal(typeof body.message, 'string');
});

test('POST rejects arbitrary URLs, invalid actions, and cross-site writes', async () => {
  const store = memoryStore();
  const handler = trackingHandler({ env, store, fetchImpl: async () => new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' })) });
  for (const body of [{ action: 'sync', url: 'https://evil.example' }, { action: 'reset' }]) {
    const response = await handler(new Request(authRequest(), { method: 'POST', body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
  const crossSite = new Request(authRequest(), { method: 'POST', headers: { authorization: 'Bearer verified.test.token', origin: 'https://evil.example' }, body: '{"action":"sync"}' });
  assert.equal((await handler(crossSite)).status, 403);
  assert.equal(store.state.claimCalls, 0);
});

test('modern Supabase secret keys use apikey only for administrative REST reads and RPCs', async () => {
  const config = getConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture_only' });
  const calls = [];
  const store = new SupabaseStore(config, async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.apikey, 'sb_secret_fixture_only');
    assert.equal(Object.hasOwn(options.headers, 'authorization'), false);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return new Response(JSON.stringify(options.method === 'GET' ? [] : { claimed: false, reason: 'budget_exhausted' }));
  });
  await store.sourceRows();
  await store.claim(awb(1), 0, false);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].url, 'https://example.supabase.co/rest/v1/rpc/cargoai_claim_subscription');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_awb: awb(1), p_budget: 0, p_allow_renewals: false });
});

test('legacy service_role JWTs retain both apikey and Bearer headers', async () => {
  const key = 'eyJhbGciOiJIUzI1NiJ9.fixture.signature';
  const store = new SupabaseStore(getConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: key }), async (url, options) => {
    assert.equal(options.headers.apikey, key);
    assert.equal(options.headers.authorization, `Bearer ${key}`);
    return new Response('[]');
  });
  await store.sourceRows();
});

test('session verification keeps the user JWT and prefers the publishable key with modern admin credentials', async () => {
  const userAuthorization = 'Bearer verified.test.token';
  const calls = [];
  const service = createTrackingService({ env: { ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture_only', SUPABASE_ANON_KEY: 'sb_publishable_fixture_only' }, fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.apikey, 'sb_publishable_fixture_only');
      assert.equal(options.headers.authorization, userAuthorization);
      return new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' }));
    }
    assert.equal(options.headers.apikey, 'sb_secret_fixture_only');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(url, `https://example.supabase.co/rest/v1/profiles?select=active&user_id=eq.${USER_ID}&limit=1`);
    return new Response('[{"active":true}]');
  } });
  assert.equal((await service.authenticate(authRequest())).id, USER_ID);
  assert.equal(calls.length, 2);
});

test('per-AWB sync selects only the requested canonical AWB already saved in the tracker', async () => {
  const store = memoryStore([awb(1)]);
  store.sourceRows = async () => [
    { key: 'jfs_joblog', value: [{ awb: awb(1) }] },
    { key: 'jfs_tracking', value: { [awb(2)]: { awb: awb(2), milestones: [{ code: 'DLV', ts: 100 }] } } }
  ];
  const sent = [];
  const handler = trackingHandler({ env, store, fetchImpl: async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' }));
    sent.push(JSON.parse(options.body));
    return providerResponse();
  } });
  const response = await handler(new Request(authRequest(), { method: 'POST', body: JSON.stringify({ action: 'sync', awb: awb(2) }) }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.sync.scanned, 1);
  assert.equal(result.sync.accepted, 1);
  assert.deepEqual(sent, [{ awb: awb(2), url: env.CARGOAI_CALLBACK_URL }]);
  assert.equal(store.state.claims.has(awb(1)), false);
  assert.equal(store.state.used, 10);
  // Legacy manual DLV entries never determine the provider status or stop a subscription.
  assert.equal(result.shipments[0].status, 'UNKNOWN');
});

test('per-AWB sync rejects valid but unsaved AWBs and noncanonical inputs before reserving credits', async () => {
  const store = memoryStore([awb(1)]);
  const handler = trackingHandler({ env, store, fetchImpl: async url => {
    assert.equal(url, 'https://example.supabase.co/auth/v1/user');
    return new Response(JSON.stringify({ id: USER_ID, email: 'operator@example.com' }));
  } });
  for (const [value, expectedStatus] of [[awb(9), 404], ['17600000011', 400], ['176-00000012', 400], [null, 400], [['176-00000011'], 400]]) {
    const response = await handler(new Request(authRequest(), { method: 'POST', body: JSON.stringify({ action: 'sync', awb: value }) }));
    assert.equal(response.status, expectedStatus);
  }
  assert.equal(store.state.claimCalls, 0);
  assert.equal(store.state.used, 0);
});

test('per-AWB sync still verifies saved membership when live requests are disabled', async () => {
  const store = memoryStore();
  const service = createTrackingService({ env: { ...env, CARGOAI_LIVE_ENABLED: 'false' }, store, fetchImpl: () => assert.fail('No provider calls') });
  assert.equal((await service.sync(awb(1))).attempted, 0);
  await assert.rejects(service.sync(awb(9)), error => error.status === 404);
  assert.equal(store.state.used, 0);
});

test('live off never reserves credits or touches provider', async () => {
  const store = memoryStore();
  const service = createTrackingService({ env: { ...env, CARGOAI_LIVE_ENABLED: 'false' }, store, fetchImpl: () => assert.fail('No network allowed') });
  assert.equal((await service.sync()).attempted, 0);
  assert.equal(store.state.used, 0);
  assert.equal(store.state.sourceReads, 0);
});

test('sync reserves before sending, uses only stored AWB and configured callback, max one request', async () => {
  const store = memoryStore([awb(1), awb(2)]);
  let calls = 0;
  const service = createTrackingService({ env, store, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(store.state.used, 10);
    assert.equal(url, 'https://api.cargoai.co/solutions/track/subscribe');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { awb: awb(1), url: env.CARGOAI_CALLBACK_URL });
    assert.equal(options.headers['x-api-key'], env.CARGOAI_API_KEY);
    return providerResponse();
  } });
  const result = await service.sync();
  assert.equal(result.accepted, 1);
  assert.equal(calls, 1);
});

test('50-credit budget prevents sixth standard subscription and is shared across callers', async () => {
  const store = memoryStore(Array.from({ length: 8 }, (_, i) => awb(i + 1)));
  let calls = 0;
  const service = createTrackingService({ env, store, fetchImpl: async () => { calls++; return providerResponse(); } });
  for (let i = 0; i < 8; i++) await service.sync();
  assert.equal(calls, 5);
  assert.equal(store.state.used, 50);
  const concurrentStore = memoryStore([awb(1)]);
  let concurrentCalls = 0;
  const make = () => createTrackingService({ env, store: concurrentStore, fetchImpl: async () => { concurrentCalls++; await new Promise(resolve => setImmediate(resolve)); return providerResponse(); } });
  await Promise.all([make().sync(), make().sync()]);
  assert.equal(concurrentCalls, 1);
});

test('ambiguous timeout and provider errors reserve credits without automatic retry', async () => {
  for (const fetchImpl of [async () => { throw new Error('timeout'); }, async () => new Response('{}', { status: 500 }), async () => new Response('{"error":"rejected"}'), async () => new Response('not-json')]) {
    const store = memoryStore();
    let calls = 0;
    const service = createTrackingService({ env, store, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    assert.equal((await service.sync()).unknown, 1);
    await service.sync();
    assert.equal(calls, 1);
    assert.equal(store.state.used, 10);
    assert.equal(store.state.claims.get(awb(1)).outcome, 'unknown');
  }
});

test('database rate-limit response never reaches provider', async () => {
  const store = { ...memoryStore(), claim: async () => ({ reason: 'rate_limited' }) };
  const result = await createTrackingService({ env, store, fetchImpl: () => assert.fail('must not send') }).sync();
  assert.equal(result.attempted, 0);
});

test('HMAC requires canonical Base64 SHA256 over exact bytes, not hex or reparsed JSON', () => {
  const raw = Buffer.from('{ "awb": "176-00000011" }\n');
  assert.equal(verifySignature(raw, sign(raw), env.CARGOAI_API_KEY), true);
  assert.equal(verifySignature(Buffer.from('{"awb":"176-00000011"}'), sign(raw), env.CARGOAI_API_KEY), false);
  assert.equal(verifySignature(raw, createHmac('sha256', env.CARGOAI_API_KEY).update(raw).digest('hex'), env.CARGOAI_API_KEY), false);
  assert.equal(verifySignature(raw, sign(raw).replace(/=$/, ''), env.CARGOAI_API_KEY), false);
  assert.equal(verifySignature(raw, ` ${sign(raw)}`, env.CARGOAI_API_KEY), false);
  assert.equal(verifySignature(raw, sign(raw), 'different-key'), false);
});

test('unsigned callbacks and unconfigured HMAC are rejected before database writes', async () => {
  const store = memoryStore();
  const request = () => new Request('https://dgdoc.example.com/.netlify/functions/cargoai-webhook', { method: 'POST', body: JSON.stringify({ awb: awb(1) }) });
  assert.equal((await webhookHandler({ env, store })(request())).status, 401);
  assert.equal((await webhookHandler({ env: { ...env, CARGOAI_WEBHOOK_HMAC_ENABLED: 'false' }, store })(request())).status, 503);
  assert.equal(store.state.receipts.size, 0);
});

test('duplicate signed payload is idempotent and contains no stored authentication material', async () => {
  const store = memoryStore();
  const service = createTrackingService({ env, store });
  const raw = Buffer.from(JSON.stringify({ awb: awb(1), status: 'IN_TRANSIT', events: [] }));
  assert.equal((await service.webhook(raw, sign(raw))).duplicate, false);
  assert.equal((await service.webhook(raw, sign(raw))).duplicate, true);
  assert.equal(store.state.receipts.size, 1);
  assert.equal(JSON.stringify(store.state.lastWebhook).includes(env.CARGOAI_API_KEY), false);
});

test('parser rejects prototype keys, array roots, huge input, and excessive nesting', async () => {
  assert.throws(() => parseJson(Buffer.from('{"__proto__":{"polluted":true}}')));
  assert.throws(() => parseJson(Buffer.from('[]')));
  assert.throws(() => parseJson(Buffer.from('{"a":'.repeat(12) + '1' + '}'.repeat(12))));
  assert.equal({}.polluted, undefined);
  await assert.rejects(readRawBody(new Request('https://example.com', { method: 'POST', body: 'x'.repeat(1025) }), 1024), e => e.status === 413);
});

test('actual destination arrival is used; intermediate, planned and partial events stay separate', () => {
  const event = (code, eventLocation, eventDate, more = {}) => ({ code, eventLocation, eventDate, isPlanned: false, pieces: '10', ...more });
  const payload = { awb: awb(1), status: 'IN_TRANSIT', origin: 'DXB', destination: 'LHR', pieces: '10', events: [
    event('DEP', 'DXB', '2026-09-20T03:00:00+04:00'),
    event('ARR', 'DOH', '2026-09-20T05:00:00+03:00'),
    event('ARR', 'LHR', '2026-09-20T20:00:00Z', { isPlanned: true }),
    event('ARR', 'LHR', '2026-09-20T17:00:00Z', { pieces: '5', isSplit: true }),
    event('DLV', 'LHR', '2026-09-20T18:00:00Z')
  ] };
  const result = normalizeTrackingPayload(payload);
  assert.equal(result.status, 'IN_TRANSIT');
  assert.equal(result.departedAt, '2026-09-19T23:00:00.000Z');
  assert.equal(result.arrivedAt, null);
  assert.equal(result.deliveredAt, null);
  assert.equal(result.events.length, 5);
  payload.events.push(event('ARR', 'LHR', '2026-09-21T05:00:00Z'));
  payload.status = 'DELIVERED';
  assert.equal(normalizeTrackingPayload(payload).arrivedAt, '2026-09-21T05:00:00.000Z');
  assert.equal(normalizeTrackingPayload(payload).deliveredAt, '2026-09-20T18:00:00.000Z');
});

test('missing planned flag or shipment quantities cannot imply completed milestones', () => {
  const payload = { awb: awb(1), status: 'DELIVERED', origin: 'DXB', destination: 'LHR', events: [{ code: 'DLV', eventLocation: 'LHR', eventDate: '2026-09-20T18:00:00Z' }] };
  const result = normalizeTrackingPayload(payload);
  assert.equal(result.deliveredAt, null);
  assert.equal(result.events[0].isPlanned, null);
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.terminal, true);
});

test('freshness watermark excludes planned, predicted, future and malformed event times', () => {
  const now = new Date('2026-09-26T00:00:00Z');
  const payload = { awb: awb(1), status: 'AT_DESTINATION', events: [
    { code: 'ARR', isPlanned: false, eventDate: '2026-09-20T12:00:00Z' },
    { code: 'DLV', isPlanned: true, eventDate: '2026-09-27T12:00:00Z' },
    { code: 'DLV', isPlanned: false, isPredicted: true, eventDate: '2026-09-25T12:00:00Z' },
    { code: 'DLV', isPlanned: false, eventDate: '2026-10-01T12:00:00Z' },
    { code: 'DEP', isPlanned: false, eventDate: '2026-02-31T12:00:00Z' }
  ] };
  const result = normalizeTrackingPayload(payload, now);
  assert.equal(result.eventWatermark, '2026-09-20T12:00:00.000Z');
  assert.equal(result.events.at(-1).eventDate, null);
  assert.equal(normalizeTrackingPayload({ awb: awb(1), status: 'DELIVERED', events: [] }, now).eventWatermark, null);
  const future = normalizeTrackingPayload({ awb: awb(1), status: 'DELIVERED', origin: 'DXB', destination: 'LHR', pieces: '10', events: [
    { code: 'DEP', eventLocation: 'DXB', isPlanned: false, pieces: '10', eventDate: '2026-09-27T12:00:00Z' },
    { code: 'ARR', eventLocation: 'LHR', isPlanned: false, pieces: '10', eventDate: '2026-09-27T14:00:00Z' },
    { code: 'DLV', eventLocation: 'LHR', isPlanned: false, pieces: '10', eventDate: '2026-09-27T18:00:00Z' }
  ] }, now);
  assert.equal(future.departedAt, null);
  assert.equal(future.arrivedAt, null);
  assert.equal(future.deliveredAt, null);
});

test('scheduler has a platform schedule and remains inert outside intentional automatic production mode', async () => {
  assert.equal(scheduleConfig.schedule, '@hourly');
  const old = { CONTEXT: process.env.CONTEXT, CARGOAI_AUTO_SYNC_ENABLED: process.env.CARGOAI_AUTO_SYNC_ENABLED };
  try {
    process.env.CONTEXT = 'production';
    process.env.CARGOAI_AUTO_SYNC_ENABLED = 'false';
    await scheduled();
    process.env.CONTEXT = 'dev';
    process.env.CARGOAI_AUTO_SYNC_ENABLED = 'true';
    await scheduled();
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
