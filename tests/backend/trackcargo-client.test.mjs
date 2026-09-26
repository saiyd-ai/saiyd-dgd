import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createTrackCargoClient, TrackCargoError } from '../../netlify/functions/_lib/trackcargo-client.mjs';

const KEY = 'fixture-trackcargo-key-never-real';
const ID = '2a2da1ac-8647-4d5e-bfe6-6a3cdf0b8edc';
const env = { TRACKCARGO_API_KEY: KEY };
const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const client = (fetchImpl, options = {}) => createTrackCargoClient({ env, fetchImpl, ...options });
const noNetwork = () => assert.fail('Invalid input must not reach the provider');
const hasError = (code, status) => error => {
  assert.ok(error instanceof TrackCargoError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(inspect(error).includes(KEY), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};

test('only the three fixed GET endpoints receive the secret, with no redirect or credential forwarding', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    return json({ untouched: { arbitrary: [true, null, 'provider field'] } });
  });
  assert.deepEqual(Object.keys(api).sort(), ['getOrder', 'getTracking', 'listAirOrders']);
  assert.equal(Object.isFrozen(api), true);
  assert.equal(inspect(api).includes(KEY), false);
  assert.deepEqual(await api.getOrder(ID.toUpperCase()), { untouched: { arbitrary: [true, null, 'provider field'] } });
  await api.getTracking(ID);
  await api.listAirOrders();
  assert.deepEqual(calls.map(call => call.url), [
    `https://api.trackcargo.co/api/v1/client-orders/${ID}`,
    `https://api.trackcargo.co/api/v1/client-orders/${ID}/tracking`,
    'https://api.trackcargo.co/api/v1/client-orders/air'
  ]);
  for (const { url, options } of calls) {
    assert.equal(url.includes(KEY), false);
    assert.equal(options.method, 'GET');
    assert.equal(Object.hasOwn(options, 'body'), false);
    assert.deepEqual(options.headers, { accept: 'application/json', 'x-api-key': KEY });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('malformed IDs, URLs and path/query injection are rejected before any fetch', async () => {
  const api = client(noNetwork);
  for (const id of [undefined, null, 42, {}, [], '', '02018224861', ID.replaceAll('-', ''), `${ID}\n`, ` ${ID}`, `${ID}/tracking`, `${ID}?key=${KEY}`, `https://evil.example/${ID}`, '..', ID.replace('2', 'z')]) {
    await assert.rejects(api.getOrder(id), hasError('invalid_order_id', 400));
    await assert.rejects(api.getTracking(id), hasError('invalid_order_id', 400));
  }
});

test('missing or malformed server credentials never make requests or appear in errors', async () => {
  for (const apiKey of [undefined, null, 123, '', ' ', ` ${KEY}`, `${KEY}\n`, `${KEY}\r\nx-evil: true`, '\u00e9', 'x'.repeat(4097)]) {
    const api = client(noNetwork, { env: { TRACKCARGO_API_KEY: apiKey } });
    await assert.rejects(api.getOrder(ID), hasError('configuration', 503));
    await assert.rejects(api.listAirOrders(), hasError('configuration', 503));
  }
  await assert.rejects(client(noNetwork, { env: null }).getTracking(ID), hasError('configuration', 503));
});

test('request limits cannot be disabled or expanded without bound', () => {
  for (const options of [
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: Infinity }, { timeoutMs: '7' },
    { maxResponseBytes: 0 }, { maxResponseBytes: 2 * 1024 * 1024 + 1 },
    { maxResponseBytes: NaN }, { maxResponseBytes: 1.5 }, { fetchImpl: null }
  ]) assert.throws(() => client(noNetwork, options), hasError('configuration', 503));
});

test('provider denials and failures expose only fixed messages and are never retried', async () => {
  for (const [status, code, safeStatus] of [[401, 'unauthorized', 401], [403, 'forbidden', 403], [404, 'not_found', 404], [429, 'rate_limited', 429], [400, 'provider_error', 502], [500, 'provider_error', 502], [503, 'provider_error', 502]]) {
    let calls = 0;
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`secret provider body ${KEY}`)); }, cancel() { cancelled = true; } });
    const api = client(async () => { calls++; return new Response(body, { status, headers: { 'retry-after': KEY } }); });
    await assert.rejects(api.getTracking(ID), error => {
      hasError(code, safeStatus)(error);
      assert.equal(inspect(error).includes('secret provider body'), false);
      assert.equal(Object.hasOwn(error, 'headers'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test('redirect responses and transport exceptions never leak the key or follow Location', async () => {
  for (const status of [301, 302, 307, 308]) {
    let calls = 0;
    const api = client(async () => { calls++; return new Response('', { status, headers: { location: `https://evil.example/?token=${KEY}` } }); });
    await assert.rejects(api.getOrder(ID), hasError('redirect', 502));
    assert.equal(calls, 1);
  }
  const redirected = json({});
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(async () => redirected).listAirOrders(), hasError('redirect', 502));
  await assert.rejects(client(async () => { throw new Error(`redirect failed with credential ${KEY}`); }).listAirOrders(), hasError('unavailable', 503));
});

test('JSON parsing preserves unknown provider shapes without inventing fields or following links', async () => {
  for (const value of [null, [], 42, 'opaque', { data: [{ unknown: true }], next: 'https://evil.example/' }]) {
    let calls = 0;
    const api = client(async () => { calls++; return json(value, { headers: { 'content-type': 'application/vnd.trackcargo+json; charset=utf-8' } }); });
    assert.deepEqual(await api.listAirOrders(), value);
    assert.equal(calls, 1);
  }
});

test('invalid JSON, MIME types, UTF-8 and content lengths are sanitized', async () => {
  const responses = [
    () => new Response(`broken ${KEY}`, { headers: { 'content-type': 'application/json' } }),
    () => new Response(`<html>${KEY}</html>`, { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}'),
    () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }),
    () => json({}, { headers: { 'content-length': 'invalid' } }),
    () => json({}, { headers: { 'content-length': '-1' } })
  ];
  for (const response of responses) await assert.rejects(client(async () => response()).getOrder(ID), hasError('invalid_response', 502));
});

test('response size is bounded by bytes, regardless of missing or dishonest Content-Length', async () => {
  const limit = 20;
  await assert.rejects(client(async () => json({}, { headers: { 'content-length': '21' } }), { maxResponseBytes: limit }).getOrder(ID), hasError('response_too_large', 502));
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('"' + '\u00e9'.repeat(10) + '"'));
    }, cancel() { cancelled = true; } });
    const api = client(async () => new Response(body, { headers: { 'content-type': 'application/json', ...headers } }), { maxResponseBytes: limit });
    await assert.rejects(api.getTracking(ID), hasError('response_too_large', 502));
    assert.equal(cancelled, true);
  }
  assert.deepEqual(await client(async () => json({}), { maxResponseBytes: 2 }).getOrder(ID), {});
});

test('one deadline bounds stalled headers and stalled bodies and aborts the transport', async () => {
  let signal;
  const api = client(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 20 });
  await assert.rejects(api.getOrder(ID), hasError('timeout', 504));
  assert.equal(signal.aborted, true);

  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const streamApi = client(async () => new Response(body, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 20 });
  await assert.rejects(streamApi.getTracking(ID), hasError('timeout', 504));
  assert.equal(cancelled, true);
});
