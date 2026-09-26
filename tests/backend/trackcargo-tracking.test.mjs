import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, readOrderMap } from '../../netlify/functions/trackcargo-tracking.mjs';
import { TrackCargoError } from '../../netlify/functions/_lib/trackcargo-client.mjs';

const ID = '01234567-89ab-cdef-0123-456789abcdef';
const ID2 = '11234567-89ab-cdef-0123-456789abcdef';
const AWB = '176-00000011', AWB2 = '176-00000022';
const target = { awb: AWB, orderId: ID };
const baseEnv = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  TRACKING_ALLOWED_EMAILS: 'operator@example.com', TRACKCARGO_API_KEY: 'test-private-trackcargo-key',
  TRACKCARGO_ORDERS_JSON: JSON.stringify([target]), CONTEXT: 'production',
  CARGOAI_LIVE_ENABLED: 'false', CARGOAI_AUTO_SYNC_ENABLED: 'false'
};
function setup(overrides = {}) {
  const calls = { order: 0, tracking: 0, auth: 0, sources: 0, profiles: 0 };
  let timestamp = new Date('2026-09-26T20:00:00Z');
  const client = {
    async getOrder(id) { calls.order++; return { success: true, error: null, data: { orderId: id, trackingId: AWB.replace('-', ''), trackingType: 'air', status: 'pending', deleted: false } }; },
    async getTracking() { calls.tracking++; return { success: true, error: null, data: { trackingData: null, status: 'INCONCLUSIVE' } }; }
  };
  const store = {
    async activeProfile() { calls.profiles++; return true; },
    async sourceRows() { calls.sources++; return [{ key: 'jfs_joblog', value: [{ awb: AWB }] }]; },
    async claim() { assert.fail('Read-only TrackCargo must not reserve CargoAi credits.'); },
    async request() { assert.fail('No database writes are part of the read-only connection.'); }
  };
  const fetchImpl = async (url, options) => {
    calls.auth++;
    assert.equal(url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(options.headers.authorization, 'Bearer verified.token');
    return new Response(JSON.stringify({ id: ID, email: 'operator@example.com' }));
  };
  return { calls, client, store, setTime(value) { timestamp = new Date(value); }, handler: makeHandler({ env: baseEnv, client, store, fetchImpl, now: () => timestamp, ...overrides }) };
}
function request(options = {}) {
  return new Request(`https://dgdoc.example/.netlify/functions/trackcargo-tracking${options.query || ''}`, { method: options.method || 'GET', headers: options.auth === false ? {} : { authorization: 'Bearer verified.token' } });
}

test('configured order mappings are canonical, unique and bounded; never accept arbitrary URLs or fields', () => {
  assert.deepEqual(readOrderMap(JSON.stringify([target])), [target]);
  assert.equal(readOrderMap(JSON.stringify([{ ...target, awb: null }])), null);
  for (const value of [null, '', '{}', '[]', JSON.stringify([{ ...target, awb: '17600000011' }]), JSON.stringify([{ ...target, orderId: 'https://evil.test' }]), JSON.stringify([{ ...target, extra: true }]), JSON.stringify([target, target]), JSON.stringify([target, { awb: AWB2, orderId: ID }]), JSON.stringify(Array.from({ length: 6 }, () => target))]) assert.equal(readOrderMap(value), null);
});

test('read-only report authenticates every caller and reads existing saved orders with CargoAi paused', async () => {
  const { handler, calls } = setup();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.mode, 'read_only');
  assert.equal(body.shipments.length, 1);
  assert.equal(body.shipments[0].awb, AWB);
  assert.equal(body.shipments[0].dataStatus, 'INCONCLUSIVE');
  assert.equal(body.shipments[0].status, 'UNKNOWN');
  assert.deepEqual(calls, { order: 1, tracking: 1, auth: 1, sources: 1, profiles: 1 });
  assert.equal(JSON.stringify(body).includes(baseEnv.TRACKCARGO_API_KEY), false);
});

test('no bearer, unauthorized account and inactive profile cannot reach provider', async () => {
  const noBearer = setup();
  assert.equal((await noBearer.handler(request({ auth: false }))).status, 401);
  assert.equal(noBearer.calls.order, 0);
  const inactive = setup({ store: { activeProfile: async () => false } });
  assert.equal((await inactive.handler(request())).status, 403);
  assert.equal(inactive.calls.order, 0);
  const forbidden = setup({ env: { ...baseEnv, TRACKING_ALLOWED_EMAILS: 'other@example.com' } });
  assert.equal((await forbidden.handler(request())).status, 403);
  assert.equal(forbidden.calls.order, 0);
});

test('nonproduction, missing key and invalid map remain disconnected without provider calls', async () => {
  for (const env of [{ ...baseEnv, CONTEXT: 'deploy-preview' }, { ...baseEnv, CONTEXT: 'branch-deploy' }, { ...baseEnv, TRACKCARGO_API_KEY: '' }, { ...baseEnv, TRACKCARGO_ORDERS_JSON: 'invalid' }]) {
    const { handler, calls } = setup({ env });
    const body = await (await handler(request())).json();
    assert.equal(body.configured, false);
    assert.deepEqual(body.shipments, []);
    assert.equal(calls.order, 0);
  }
});

test('only saved company AWBs may be fetched, even when additional orders are configured', async () => {
  const { handler, calls } = setup({ env: { ...baseEnv, TRACKCARGO_ORDERS_JSON: JSON.stringify([target, { awb: AWB2, orderId: ID2 }]) } });
  assert.equal((await (await handler(request())).json()).shipments.length, 1);
  assert.equal(calls.order, 1);
  const none = setup({ store: { activeProfile: async () => true, sourceRows: async () => [] } });
  assert.deepEqual((await (await none.handler(request())).json()).shipments, []);
  assert.equal(none.calls.order, 0);
});

test('POST/PUT and caller-selected order IDs cannot make any provider request', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request({ method: 'POST' }))).status, 405);
  assert.equal((await handler(request({ method: 'PUT' }))).status, 405);
  assert.equal((await handler(request({ query: `?orderId=${ID}` }))).status, 400);
  assert.equal(calls.order, 0);
});

test('bounded memory cache and concurrent reads coalesce provider requests but recheck authorization and membership', async () => {
  const context = setup();
  await Promise.all([context.handler(request()), context.handler(request())]);
  assert.equal(context.calls.order, 1);
  assert.equal(context.calls.auth, 2);
  assert.equal(context.calls.sources, 2);
  await context.handler(request());
  assert.equal(context.calls.order, 1);
  context.setTime('2026-09-26T20:01:01Z');
  await context.handler(request());
  assert.equal(context.calls.order, 2);
});

test('provider failures and mismatched identities produce sanitized per-order errors without writes or blind retries', async () => {
  const rateLimited = setup({ client: { getOrder: async () => { throw new TrackCargoError('rate_limited'); }, getTracking: async () => ({}) } });
  let body = await (await rateLimited.handler(request())).json();
  assert.equal(body.shipments[0].dataStatus, 'ERROR');
  assert.equal(body.shipments[0].message, 'TrackCargo request limit reached. Try again later.');
  const malformed = setup({ client: { getOrder: async () => ({ success: true, data: { trackingId: AWB2.replace('-', ''), orderId: ID } }), getTracking: async () => ({}) } });
  body = await (await malformed.handler(request())).json();
  assert.equal(body.shipments[0].dataStatus, 'ERROR');
  assert.match(body.shipments[0].message, /could not be verified/);
  assert.equal(JSON.stringify(body).includes(baseEnv.TRACKCARGO_API_KEY), false);
});
