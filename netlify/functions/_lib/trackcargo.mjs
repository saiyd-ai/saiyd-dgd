import { HttpError, normalizeAwb } from './cargoai.mjs';

// Adapter for the observed AVAILABLE / INCONCLUSIVE air responses. Raw provider
// objects (organisation, parties, documents, emissions, etc.) never leave here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 2000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const airport = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) && value.length === 3 ? value : null;
const token = (value, max = 32) => typeof value === 'string' && value.length <= max && /^[A-Z0-9_-]+$/.test(value) ? value : null;
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;

export class TrackCargoNormalizationError extends HttpError {
  constructor(code = 'invalid_response') {
    super(502, code === 'identity_mismatch' ? 'TrackCargo shipment identity did not match the configured order.' : 'TrackCargo returned an unsupported tracking response.');
    this.name = 'TrackCargoNormalizationError';
    this.code = code === 'identity_mismatch' ? code : 'invalid_response';
  }
}

function envelope(value) {
  if (!record(value) || value.success !== true || value.error !== null || !record(value.data)) throw new TrackCargoNormalizationError();
  return value.data;
}

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const normalized = new Date(instant).toISOString();
  // Date.parse accepts some impossible calendar dates by rolling into the next month.
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

function eventUtc(value) {
  // date_iso.date contains local wall time with a misleading Z in the observed API.
  // Never use it, date.$date, or route ETA fields as a fallback for an actual event.
  const date = record(value.date_utc_iso) ? utcDate(value.date_utc_iso.date) : null;
  if (!date) return null;
  if (value.date_utc !== undefined) {
    if (!record(value.date_utc) || !Number.isSafeInteger(value.date_utc.$date) || value.date_utc.$date !== Date.parse(date)) return null;
  }
  return date;
}

function timezone(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^[A-Za-z0-9_+/-]+$/.test(value)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return null; }
}

function quantity(value, whole = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12 || (whole && !Number.isSafeInteger(value))) return null;
  return String(value);
}

function event(value, nowMs) {
  if (!record(value)) return null;
  const code = token(value.carrier_event_code);
  if (!code) return null;
  const eventDate = eventUtc(value);
  const elapsed = typeof value.elapsed === 'boolean' ? value.elapsed : null;
  const actual = elapsed === true && eventDate !== null && Date.parse(eventDate) <= nowMs;
  const timeKind = actual ? 'actual' : elapsed === false ? 'planned' : 'unknown';
  const number = token(value.flight_no, 20);
  return {
    provider: 'trackcargo', code, description: text(value.carrier_event_description),
    eventDate, eventLocation: airport(value.location), timezone: timezone(value.timezone),
    elapsed, timeKind, isPlanned: timeKind === 'actual' ? false : timeKind === 'planned' ? true : null,
    isPredicted: null, isSplit: null,
    pieces: quantity(value.pieces, true), weight: quantity(value.weight), weightUnit: text(value.weight_unit, 12),
    flightNumber: number,
    // The observed response does not attach a verified flight leg to every event.
    flight: { number, origin: null, destination: null, actualDeparture: null, actualArrival: null,
      scheduledDeparture: null, scheduledArrival: null, estimatedDeparture: null, estimatedArrival: null }
  };
}

function assertTrackingIdentity(data, digits) {
  const awb = data.awb;
  if (data.tracking_id !== digits || !record(awb) || awb.prefix !== digits.slice(0, 3) || awb.number !== digits.slice(3)
      || (awb.serial_no !== undefined && awb.serial_no !== digits.slice(3, 10))
      || (awb.check_digit !== undefined && awb.check_digit !== digits.slice(10))) throw new TrackCargoNormalizationError('identity_mismatch');
}

export function normalizeTrackCargoShipment({ awb, orderId, order, tracking, now = new Date() }) {
  if (typeof awb !== 'string' || normalizeAwb(awb) !== awb || typeof orderId !== 'string' || orderId.length !== 36 || !UUID.test(orderId)) {
    throw new TrackCargoNormalizationError('identity_mismatch');
  }
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new TrackCargoNormalizationError();
  const details = envelope(order);
  const payload = envelope(tracking);
  const digits = awb.replace('-', '');
  if (typeof details.orderId !== 'string' || details.orderId.toLowerCase() !== orderId.toLowerCase() || details.trackingId !== digits) {
    throw new TrackCargoNormalizationError('identity_mismatch');
  }
  if (details.trackingType !== 'air' || details.deleted !== false || typeof details.status !== 'string'
      || details.status.length > 32 || !/^[a-z_]+$/.test(details.status)) throw new TrackCargoNormalizationError();

  const result = {
    awb, orderId: orderId.toLowerCase(), provider: 'trackcargo', orderStatus: details.status,
    dataStatus: payload.status, status: 'UNKNOWN', statusScope: 'latest_actual_event', statusDescription: null,
    origin: null, destination: null, flight: null, currentLocation: null,
    departedAt: null, arrivedAt: null, deliveredAt: null, plannedArrivalAt: null, plannedDeliveryAt: null,
    lastUpdate: null, eventWatermark: null, fetchedAt: now.toISOString(), providerUpdatedAt: utcDate(details.updatedAt),
    events: []
  };
  if (payload.status === 'INCONCLUSIVE' && payload.trackingData === null) return result;
  if (payload.status !== 'AVAILABLE' || !record(payload.trackingData) || !Array.isArray(payload.trackingData.events)
      || payload.trackingData.events.length > MAX_EVENTS) throw new TrackCargoNormalizationError();
  const data = payload.trackingData;
  assertTrackingIdentity(data, digits);
  result.origin = airport(data.origin_airport_code);
  result.destination = airport(data.destination_airport_code);
  result.events = data.events.map(value => event(value, nowMs)).filter(Boolean);

  const actual = result.events.filter(value => value.timeKind === 'actual').sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const latest = actual.at(-1);
  if (latest) {
    result.status = latest.code;
    result.statusDescription = latest.description;
    result.currentLocation = latest.eventLocation;
    result.lastUpdate = latest.eventDate;
    result.eventWatermark = latest.eventDate;
  }
  result.flight = [...new Set(actual.map(value => value.flightNumber).filter(Boolean))].join(', ').slice(0, 240) || null;
  result.departedAt = actual.find(value => result.origin && value.code === 'DEP' && value.eventLocation === result.origin)?.eventDate || null;
  // This is an origin departure EVENT, not proof the whole shipment departed.
  // No trustworthy shipment total exists in the observed payload (booking and
  // accepted quantities differ). ARR/DLV events remain visible, but never imply
  // verified full-shipment arrival or delivery summary dates.
  const planned = result.events.filter(value => value.timeKind === 'planned' && value.eventDate)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  result.plannedArrivalAt = planned.find(value => result.destination && value.code === 'ARR' && value.eventLocation === result.destination)?.eventDate || null;
  result.plannedDeliveryAt = planned.find(value => result.destination && value.code === 'DLV' && value.eventLocation === result.destination)?.eventDate || null;
  return result;
}
