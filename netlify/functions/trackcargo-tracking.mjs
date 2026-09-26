import { authenticate, errorResponse, extractSavedAwbs, getConfig, HttpError, json, normalizeAwb, SupabaseStore } from './_lib/cargoai.mjs';
import { createTrackCargoClient, TrackCargoError } from './_lib/trackcargo-client.mjs';
import { normalizeTrackCargoShipment } from './_lib/trackcargo.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ORDERS = 5;
const CACHE_MS = 60000;

export function readOrderMap(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let rows;
  try { rows = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ORDERS) return null;
  const awbs = new Set(), ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'awb,orderId'
      || typeof row.awb !== 'string' || normalizeAwb(row.awb) !== row.awb || typeof row.orderId !== 'string'
      || !UUID.test(row.orderId) || awbs.has(row.awb) || ids.has(row.orderId.toLowerCase())) return null;
    awbs.add(row.awb); ids.add(row.orderId.toLowerCase());
  }
  return rows.map(({ awb, orderId }) => ({ awb, orderId: orderId.toLowerCase() }));
}

export function makeHandler({ env = process.env, fetchImpl = fetch, store: suppliedStore, client: suppliedClient, now = () => new Date() } = {}) {
  const config = getConfig(env);
  const store = suppliedStore || new SupabaseStore(config, fetchImpl);
  const orders = readOrderMap(env.TRACKCARGO_ORDERS_JSON);
  const configured = Boolean(config.databaseConfigured && env.TRACKCARGO_API_KEY && orders && (!env.CONTEXT || env.CONTEXT === 'production'));
  const client = suppliedClient || createTrackCargoClient({ env, fetchImpl });
  // Memory-only cache coalesces clicks. Authorization and saved-AWB membership are
  // rechecked on every request; provider snapshots are never written over history.
  const cache = new Map(), pending = new Map();

  async function readShipment(target) {
    const stamp = now().getTime();
    const previous = cache.get(target.orderId);
    if (previous && previous.expires > stamp) return previous.shipment;
    if (pending.has(target.orderId)) return pending.get(target.orderId);
    const operation = Promise.resolve().then(async () => {
      try {
        const [order, tracking] = await Promise.all([client.getOrder(target.orderId), client.getTracking(target.orderId)]);
        const shipment = normalizeTrackCargoShipment({ ...target, order, tracking, now: now() });
        cache.set(target.orderId, { shipment, expires: now().getTime() + CACHE_MS });
        return shipment;
      } catch (error) {
        const shipment = {
          awb: target.awb, provider: 'trackcargo', orderId: target.orderId,
          dataStatus: 'ERROR', status: 'UNKNOWN', events: [],
          message: error instanceof TrackCargoError ? error.message : 'TrackCargo data could not be verified. Try refreshing later.'
        };
        cache.set(target.orderId, { shipment, expires: now().getTime() + 15000 });
        return shipment;
      } finally { pending.delete(target.orderId); }
    });
    pending.set(target.orderId, operation);
    return operation;
  }

  return async request => {
    try {
      if (request.method !== 'GET') throw new HttpError(405, 'Use GET to read existing TrackCargo orders.');
      if (new URL(request.url).search) throw new HttpError(400, 'This report uses only server-configured existing orders.');
      await authenticate(request, config, store, fetchImpl);
      if (!configured) return json({ configured: false, mode: 'read_only', shipments: [], message: 'TrackCargo connection is not configured for this deployment.' });
      const saved = new Set(extractSavedAwbs(await store.sourceRows()).awbs);
      const targets = orders.filter(order => saved.has(order.awb));
      const shipments = await Promise.all(targets.map(readShipment));
      const failed = shipments.filter(row => row.dataStatus === 'ERROR').length;
      return json({
        configured: true, mode: 'read_only', shipments,
        message: targets.length
          ? `Existing TrackCargo orders only. No new tracking orders were created.${failed ? ` ${failed} order(s) could not be refreshed.` : ''}`
          : 'No configured TrackCargo orders match saved company AWBs.'
      });
    } catch (error) { return errorResponse(error); }
  };
}

export default makeHandler();
