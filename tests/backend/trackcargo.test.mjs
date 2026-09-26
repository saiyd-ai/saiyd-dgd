import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrackCargoShipment, TrackCargoNormalizationError } from '../../netlify/functions/_lib/trackcargo.mjs';

// Minimal, redacted observed shape; no organisation/user IDs, parties or secrets.
const AWB = '020-12345675';
const ID = '2a2da1ac-8647-4d5e-bfe6-6a3cdf0b8edc';
const NOW = new Date('2026-09-26T21:00:00Z');
const envelope = data => ({ success: true, error: null, warnings: [], data });
const sampleEvent = (code, location, utc, elapsed, extra = {}) => ({
  carrier_event_code: code, carrier_event_description: code === 'RCF' ? 'Received from flight' : `Carrier ${code}`,
  location, date_utc_iso: { date: utc }, date_utc: { $date: Date.parse(utc) },
  date_iso: { date: '2026-09-25T00:03:00.000Z' }, timezone: 'Europe/Vienna',
  elapsed, pieces: elapsed ? 7 : null, weight: elapsed ? 2721 : null, weight_unit: 'kg', flight_no: null, ...extra
});
function sample() {
  return {
    awb: AWB, orderId: ID, now: NOW,
    order: envelope({ orderId: ID, trackingId: '02012345675', trackingType: 'air', deleted: false, status: 'active', updatedAt: '2026-09-26T20:15:07.556Z' }),
    tracking: envelope({ status: 'AVAILABLE', trackingData: {
      awb: { prefix: '020', number: '12345675', serial_no: '1234567', check_digit: '5' }, tracking_id: '02012345675',
      origin_airport_code: 'DWC', destination_airport_code: 'JFK', completed: false,
      events: [
        sampleEvent('BKD', 'DWC', '2026-09-22T17:17:00.000Z', true, { pieces: 108, weight: 38760, timezone: 'Asia/Dubai' }),
        sampleEvent('RCS', 'DWC', '2026-09-22T21:05:00.000Z', true, { timezone: 'Asia/Dubai' }),
        sampleEvent('MAN', 'DWC', '2026-09-23T02:57:00.000Z', true, { flight_no: 'LH8015' }),
        sampleEvent('DEP', 'DWC', '2026-09-23T04:58:00.000Z', true),
        sampleEvent('ARR', 'FRA', '2026-09-23T12:04:00.000Z', true),
        sampleEvent('RCF', 'FRA', '2026-09-23T15:10:00.000Z', true),
        sampleEvent('MAN', 'FRA', '2026-09-24T02:41:00.000Z', true, { flight_no: 'LH7562S' }),
        sampleEvent('DEP', 'FRA', '2026-09-24T04:15:00.000Z', true),
        sampleEvent('ARR', 'VIE', '2026-09-24T17:48:00.000Z', true),
        sampleEvent('RCF', 'VIE', '2026-09-24T22:03:00.000Z', true),
        sampleEvent('MAN', 'VIE', '2026-09-27T13:32:00.000Z', false, { flight_no: 'OS035' }),
        sampleEvent('DEP', 'VIE', '2026-09-27T14:55:00.000Z', false),
        sampleEvent('ARR', 'JFK', '2026-09-28T00:05:00.000Z', false, { timezone: 'America/New_York', date_iso: { date: '2026-09-27T20:05:00.000Z' } }),
        sampleEvent('RCF', 'JFK', '2026-09-28T12:41:00.000Z', false),
        sampleEvent('NFD', 'JFK', '2026-09-28T18:05:00.000Z', false),
        sampleEvent('DLV', 'JFK', '2026-09-28T18:05:00.000Z', false)
      ]
    } })
  };
}
const data = fixture => fixture.tracking.data.trackingData;
const rejected = (fixture, code = 'invalid_response') => assert.throws(() => normalizeTrackCargoShipment(fixture), error => {
  assert.ok(error instanceof TrackCargoNormalizationError);
  assert.equal(error.status, 502);
  assert.equal(error.code, code);
  return true;
});

test('Lufthansa actual watermark is Vienna UTC; planned JFK arrival and delivery stay separate', () => {
  const fixture = sample();
  const before = structuredClone(fixture);
  const result = normalizeTrackCargoShipment(fixture);
  assert.equal(result.provider, 'trackcargo');
  assert.equal(result.orderId, ID);
  assert.equal(result.orderStatus, 'active');
  assert.equal(result.dataStatus, 'AVAILABLE');
  assert.equal(result.status, 'RCF');
  assert.equal(result.statusScope, 'latest_actual_event');
  assert.equal(result.statusDescription, 'Received from flight');
  assert.equal(result.currentLocation, 'VIE');
  assert.equal(result.origin, 'DWC');
  assert.equal(result.destination, 'JFK');
  assert.equal(result.lastUpdate, '2026-09-24T22:03:00.000Z');
  assert.equal(result.eventWatermark, result.lastUpdate);
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.providerUpdatedAt, '2026-09-26T20:15:07.556Z');
  assert.equal(result.departedAt, '2026-09-23T04:58:00.000Z');
  assert.equal(result.arrivedAt, null);
  assert.equal(result.deliveredAt, null);
  assert.equal(result.plannedArrivalAt, '2026-09-28T00:05:00.000Z');
  assert.equal(result.plannedDeliveryAt, '2026-09-28T18:05:00.000Z');
  assert.equal(result.flight, 'LH8015, LH7562S');
  assert.equal(result.events.length, 16);
  assert.equal(result.events.filter(event => event.timeKind === 'actual').length, 10);
  assert.equal(result.events.filter(event => event.isPlanned === true).length, 6);
  assert.equal(result.events[9].timezone, 'Europe/Vienna');
  assert.equal(result.events[9].isPredicted, null);
  assert.equal(result.events[9].isSplit, null);
  assert.deepEqual(fixture, before);
});

test('both INCONCLUSIVE Air India shapes preserve order identity with no invented status, route or events', () => {
  for (const awb of ['098-12345675', '098-12345686']) {
    const fixture = sample();
    fixture.awb = awb;
    fixture.order.data.trackingId = awb.replace('-', '');
    fixture.order.data.status = 'pending';
    fixture.tracking = envelope({ status: 'INCONCLUSIVE', trackingData: null });
    const result = normalizeTrackCargoShipment(fixture);
    assert.equal(result.awb, awb);
    assert.equal(result.orderId, ID);
    assert.equal(result.orderStatus, 'pending');
    assert.equal(result.dataStatus, 'INCONCLUSIVE');
    assert.equal(result.status, 'UNKNOWN');
    for (const field of ['origin', 'destination', 'currentLocation', 'lastUpdate', 'eventWatermark', 'departedAt', 'arrivedAt', 'deliveredAt', 'plannedArrivalAt', 'plannedDeliveryAt']) assert.equal(result[field], null);
    assert.deepEqual(result.events, []);
  }
});

test('every observed identity field must agree with the expected canonical AWB and UUID', () => {
  for (const mutate of [
    f => { f.awb = '02012345675'; }, f => { f.awb = '020-12345676'; },
    f => { f.orderId = '../air'; }, f => { f.order.data.orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    f => { f.order.data.trackingId = '09812345675'; }, f => { data(f).tracking_id = '09812345675'; },
    f => { data(f).awb.prefix = '098'; }, f => { data(f).awb.number = '12345686'; },
    f => { data(f).awb.serial_no = '1234568'; }, f => { data(f).awb.check_digit = '6'; },
    f => { delete data(f).awb; }
  ]) { const fixture = sample(); mutate(fixture); rejected(fixture, 'identity_mismatch'); }
});

test('success envelopes, tracking modes, deleted records and unexpected schemas fail closed', () => {
  for (const mutate of [
    f => { f.order.success = false; }, f => { f.tracking.success = false; },
    f => { f.order.error = 'provider private error'; }, f => { delete f.tracking.error; },
    f => { f.order.data.trackingType = 'sea'; }, f => { f.order.data.deleted = true; },
    f => { f.order.data.status = '<script>'; }, f => { f.tracking.data.status = 'NEW_UNKNOWN_STATE'; },
    f => { f.tracking.data.trackingData = null; }, f => { f.tracking.data.status = 'INCONCLUSIVE'; },
    f => { data(f).events = {}; }, f => { f.now = new Date('invalid'); }
  ]) { const fixture = sample(); mutate(fixture); rejected(fixture); }
});

test('mislabelled local time never substitutes for UTC and contradictory or impossible UTC dates remain unknown', () => {
  for (const mutate of [
    event => { delete event.date_utc_iso; },
    event => { event.date_utc_iso = { date: '2026-02-31T12:00:00.000Z' }; delete event.date_utc; },
    event => { event.date_utc_iso = { date: '2026-09-25T00:03:00+02:00' }; delete event.date_utc; },
    event => { event.date_utc.$date += 3600000; },
    event => { event.date_utc_iso = { date: '2026-09-24T22:03:00.000' }; },
    event => { event.date_utc.$date = '1790287380000'; }
  ]) {
    const fixture = sample();
    const row = data(fixture).events[9];
    mutate(row);
    data(fixture).events = [row];
    const result = normalizeTrackCargoShipment(fixture);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.lastUpdate, null);
    assert.equal(result.events[0].eventDate, null);
    assert.equal(result.events[0].isPlanned, null);
    assert.equal(result.events[0].timeKind, 'unknown');
  }
});

test('only literal elapsed true with nonfuture UTC time contributes current status', () => {
  const fixture = sample();
  data(fixture).events.push(
    sampleEvent('DLV', 'JFK', '2026-09-28T18:05:00.000Z', true),
    sampleEvent('DLV', 'JFK', '2026-09-25T18:05:00.000Z', 'true'),
    sampleEvent('DLV', 'JFK', '2026-09-25T18:05:00.000Z', undefined),
    sampleEvent('DLV', 'JFK', '2026-09-25T18:05:00.000Z', false)
  );
  data(fixture).latest_event = sampleEvent('DLV', 'JFK', '2026-09-26T18:05:00.000Z', true);
  data(fixture).completed = true;
  const result = normalizeTrackCargoShipment(fixture);
  assert.equal(result.status, 'RCF');
  assert.equal(result.events.at(-4).timeKind, 'unknown');
  assert.equal(result.events.at(-4).isPlanned, null);
  assert.equal(result.events.at(-3).elapsed, null);
  assert.equal(result.events.at(-1).isPlanned, true);
  assert.equal(result.arrivedAt, null);
  assert.equal(result.deliveredAt, null);
});

test('partial or unknown-quantity destination events do not assert full-shipment arrival/delivery', () => {
  for (const pieces of [3, null, 7, 108]) {
    const fixture = sample();
    data(fixture).events.push(sampleEvent('ARR', 'JFK', '2026-09-25T18:00:00.000Z', true, { pieces }), sampleEvent('DLV', 'JFK', '2026-09-26T18:00:00.000Z', true, { pieces }));
    const result = normalizeTrackCargoShipment(fixture);
    assert.equal(result.status, 'DLV'); // Only the latest carrier EVENT, not a terminal shipment claim.
    assert.equal(result.statusScope, 'latest_actual_event');
    assert.equal(result.arrivedAt, null);
    assert.equal(result.deliveredAt, null);
    assert.equal(Object.hasOwn(result, 'terminal'), false);
    assert.equal(result.events.at(-1).pieces, pieces === null ? null : String(pieces));
  }
});

test('sorting uses UTC and no unknown provider fields or raw local dates are forwarded', () => {
  const fixture = sample();
  data(fixture).events.reverse();
  fixture.order.data.organisationId = 'private organisation';
  fixture.order.data.parties = [{ name: 'private party' }];
  data(fixture).emissionsSnapshot = { errorMessage: 'secret provider error' };
  data(fixture).events[0].privateField = 'secret event field';
  const result = normalizeTrackCargoShipment(fixture);
  assert.equal(result.status, 'RCF');
  assert.equal(result.departedAt, '2026-09-23T04:58:00.000Z');
  assert.equal(result.plannedArrivalAt, '2026-09-28T00:05:00.000Z');
  const encoded = JSON.stringify(result);
  for (const excluded of ['private organisation', 'private party', 'secret provider error', 'secret event field', 'date_iso', 'coordinates', '2026-09-25T00:03:00.000Z']) assert.equal(encoded.includes(excluded), false);
});

test('event count, text, quantities, airports and timezone are bounded or validated', () => {
  const oversized = sample();
  data(oversized).events = Array.from({ length: 2001 }, () => data(oversized).events[0]);
  rejected(oversized);
  const fixture = sample();
  data(fixture).events = [sampleEvent('RCF', 'VIE', '2026-09-24T22:03:00.000Z', true, {
    carrier_event_description: '\u0000' + 'a'.repeat(501), location: 'VIE\n', timezone: 'Invalid/Timezone',
    pieces: 1.5, weight: Infinity, flight_no: 'LH<script>', weight_unit: 'a'.repeat(30)
  }), null, {}, { carrier_event_code: '<script>' }];
  const result = normalizeTrackCargoShipment(fixture);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].description.length, 500);
  for (const field of ['eventLocation', 'timezone', 'pieces', 'weight', 'flightNumber']) assert.equal(result.events[0][field], null);
  assert.equal(result.events[0].weightUnit.length, 12);
});
