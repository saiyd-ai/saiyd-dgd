// Server-side transport only. No public handler, creation, polling, or webhook setup.
// Endpoint/auth reference: https://trackcargo.co/developer
const API_BASE = 'https://api.trackcargo.co';
const ORDER_PATH = '/api/v1/client-orders';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_RESPONSE_BYTES = 512 * 1024;

const ERRORS = {
  configuration: [503, 'TrackCargo server configuration is incomplete or invalid.'],
  invalid_order_id: [400, 'A canonical TrackCargo order UUID is required.'],
  unauthorized: [401, 'TrackCargo rejected the server credential.'],
  forbidden: [403, 'TrackCargo denied access. Verify the account API entitlement.'],
  not_found: [404, 'TrackCargo could not find the requested order.'],
  rate_limited: [429, 'TrackCargo request limit reached. Try again later.'],
  redirect: [502, 'TrackCargo returned an unexpected redirect.'],
  provider_error: [502, 'TrackCargo could not complete the request.'],
  invalid_response: [502, 'TrackCargo returned an invalid JSON response.'],
  response_too_large: [502, 'TrackCargo response exceeded the allowed size.'],
  unavailable: [503, 'TrackCargo is temporarily unavailable.'],
  timeout: [504, 'TrackCargo request timed out.']
};

export class TrackCargoError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'unavailable';
    const [status, message] = ERRORS[safeCode];
    super(message);
    this.name = 'TrackCargoError';
    this.code = safeCode;
    this.status = status;
  }
}

function orderId(value) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw new TrackCargoError('invalid_order_id');
  return value.toLowerCase();
}

function cancelBody(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* Cleanup must not expose provider errors. */ }
}

function statusError(status) {
  if (status >= 300 && status < 400) return new TrackCargoError('redirect');
  return new TrackCargoError(({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited' })[status] || 'provider_error');
}

async function readJson(response, maxBytes, signal) {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    throw new TrackCargoError('invalid_response');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new TrackCargoError('invalid_response');
  }
  if (length !== null && Number(length) > maxBytes) throw new TrackCargoError('response_too_large');
  if (!response.body) throw new TrackCargoError('invalid_response');

  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cleanup. */ } };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new TrackCargoError('timeout');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new TrackCargoError('timeout');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new TrackCargoError('response_too_large');
      chunks.push(value);
    }
    // Preserve the provider JSON for an internal adapter; its schema is not yet verified.
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    try { return JSON.parse(raw); } catch { throw new TrackCargoError('invalid_response'); }
  } catch (error) {
    cancel();
    if (error instanceof TrackCargoError) throw error;
    throw new TrackCargoError(signal.aborted ? 'timeout' : 'invalid_response');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function createTrackCargoClient({ env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_RESPONSE_BYTES } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024
      || typeof fetchImpl !== 'function') throw new TrackCargoError('configuration');
  // Keep the secret in this closure, never in the returned client, URLs, or errors.
  const apiKey = env?.TRACKCARGO_API_KEY;

  async function get(path) {
    if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) throw new TrackCargoError('configuration');
    const controller = new AbortController();
    let timer;
    let response;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TrackCargoError('timeout'));
      }, timeoutMs);
    });
    const request = async () => {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': apiKey },
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: controller.signal
      });
      // Also covers late responses from a custom transport that ignores abort.
      if (controller.signal.aborted) { cancelBody(response.body); throw new TrackCargoError('timeout'); }
      if (response.redirected) throw new TrackCargoError('redirect');
      if (!response.ok) throw statusError(response.status);
      return readJson(response, maxResponseBytes, controller.signal);
    };
    try {
      // The deadline bounds both receiving headers and streaming the response body.
      return await Promise.race([request(), deadline]);
    } catch (error) {
      cancelBody(response?.body);
      if (error instanceof TrackCargoError) throw error;
      // Never attach a provider exception/cause, body, headers, or credential.
      throw new TrackCargoError(controller.signal.aborted ? 'timeout' : 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async getOrder(id) { return get(`${ORDER_PATH}/${orderId(id)}`); },
    async getTracking(id) { return get(`${ORDER_PATH}/${orderId(id)}/tracking`); },
    async listAirOrders() { return get(`${ORDER_PATH}/air`); }
  });
}
