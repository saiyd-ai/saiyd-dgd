-- OPTIONAL DATABASE INTEGRATION TEST; NOT RUN AS PART OF npm test.
-- Run ONLY against an empty, disposable Supabase development project after applying
-- the migration. The guard rejects a non-empty tracking ledger. Every change rolls back.
-- No production database is needed or should be used for these tests.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $$
declare
  v_result jsonb;
  v_claim uuid;
  v_awb text;
  v_row public.cargoai_shipments%rowtype;
  v_i integer;
begin
  if exists(select 1 from public.cargoai_subscription_attempts)
    or exists(select 1 from public.cargoai_shipments)
    or exists(select 1 from public.cargoai_credit_months) then
    raise exception 'Use an empty disposable tracking database';
  end if;
  v_result := public.cargoai_claim_subscription('999-00000011', 0, false);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception 'Zero cap was bypassed'; end if;
  for v_i in 1..5 loop
    update public.cargoai_subscription_attempts set created_at = now() - interval '31 seconds';
    v_awb := '999-' || lpad(v_i::text, 7, '0') || (v_i % 7)::text;
    v_result := public.cargoai_claim_subscription(v_awb, 50, false);
    if v_result->>'claimed' <> 'true' then raise exception 'Expected claim %', v_i; end if;
    v_claim := (v_result->>'claimToken')::uuid;
    perform public.cargoai_settle_subscription(v_claim, v_i <> 2);
    v_result := public.cargoai_claim_subscription(v_awb, 50, false);
    if v_result->>'claimed' <> 'false' then raise exception 'Duplicate/unknown request retried'; end if;
  end loop;
  v_result := public.cargoai_claim_subscription('999-00000066', 50, false);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception '50 credit ceiling bypassed'; end if;
  if (select sum(reserved_credits) from public.cargoai_credit_months) <> 50 then raise exception 'Wrong reserved credits'; end if;

  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"AT_DESTINATION","origin":"DXB","destination":"LHR","eventWatermark":"2026-09-20T12:00:00Z","arrivedAt":"2026-09-20T12:00:00Z","events":[{"code":"ARR","eventDate":"2026-09-20T12:00:00Z"}]}', repeat('a',64));
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"IN_TRANSIT","origin":"DXB","destination":"LHR","eventWatermark":"2026-09-20T12:00:00Z","arrivedAt":"2026-09-19T12:00:00Z","events":[]}', repeat('b',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000011';
  if v_row.status <> 'AT_DESTINATION' or v_row.arrived_at <> '2026-09-20T12:00:00Z'::timestamptz then raise exception 'Equal-watermark snapshot regressed summary'; end if;
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"IN_TRANSIT","eventWatermark":"2026-09-19T12:00:00Z","events":[]}', repeat('c',64));
  if (select status from public.cargoai_shipments where awb = '999-00000011') <> 'AT_DESTINATION' then raise exception 'Old callback regressed status'; end if;

  -- An undated explicit terminal status may advance the status but cannot invent dates.
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"DELIVERED","events":[]}', repeat('d',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000011';
  if v_row.status <> 'DELIVERED' or v_row.delivered_at is not null then raise exception 'Undated terminal handling incorrect'; end if;
  -- Later confirmed full-quantity data can enrich an already-terminal shipment.
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"DELIVERED","origin":"DXB","destination":"LHR","eventWatermark":"2026-09-21T12:00:00Z","deliveredAt":"2026-09-21T12:00:00Z","events":[{"code":"DLV","eventDate":"2026-09-21T12:00:00Z"}]}', repeat('e',64));
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"IN_TRANSIT","eventWatermark":"2026-09-22T12:00:00Z","events":[]}', repeat('f',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000011';
  if v_row.status <> 'DELIVERED' or v_row.delivered_at <> '2026-09-21T12:00:00Z'::timestamptz then raise exception 'Terminal enrichment/regression failed'; end if;
  update public.cargoai_shipments set last_update = '2026-01-01T00:00:00Z' where awb = '999-00000011';
  v_result := public.cargoai_apply_webhook('{"awb":"999-00000011","status":"DELIVERED","events":[]}', repeat('e',64));
  if v_result->>'duplicate' <> 'true' then raise exception 'Webhook duplicate was not detected'; end if;
  if (select last_update from public.cargoai_shipments where awb = '999-00000011') <> '2026-01-01T00:00:00Z'::timestamptz then raise exception 'Duplicate bumped freshness'; end if;

  -- A newer accepted rerouting must not relabel an old airport's arrival as the new destination.
  perform public.cargoai_apply_webhook('{"awb":"999-00000033","status":"AT_DESTINATION","origin":"DXB","destination":"DOH","eventWatermark":"2026-09-20T12:00:00Z","departedAt":"2026-09-19T12:00:00Z","arrivedAt":"2026-09-20T12:00:00Z","events":[]}', repeat('1',64));
  perform public.cargoai_apply_webhook('{"awb":"999-00000033","status":"IN_TRANSIT","origin":"DXB","destination":"LHR","eventWatermark":"2026-09-21T12:00:00Z","events":[]}', repeat('2',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000033';
  if v_row.destination <> 'LHR' or v_row.arrived_at is not null or v_row.delivered_at is not null
    or v_row.departed_at <> '2026-09-19T12:00:00Z'::timestamptz then raise exception 'Destination correction retained stale endpoint dates or cleared valid origin date'; end if;
  perform public.cargoai_apply_webhook('{"awb":"999-00000033","status":"IN_TRANSIT","origin":"AUH","destination":"LHR","eventWatermark":"2026-09-22T12:00:00Z","events":[]}', repeat('3',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000033';
  if v_row.origin <> 'AUH' or v_row.departed_at is not null then raise exception 'Origin correction retained departure at old origin'; end if;
  perform public.cargoai_apply_webhook('{"awb":"999-00000033","status":"AT_DESTINATION","origin":"DXB","destination":"DOH","eventWatermark":"2026-09-20T12:00:00Z","departedAt":"2026-09-19T12:00:00Z","arrivedAt":"2026-09-20T12:00:00Z","events":[]}', repeat('4',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000033';
  if v_row.origin <> 'AUH' or v_row.destination <> 'LHR' or v_row.departed_at is not null or v_row.arrived_at is not null then raise exception 'Older route callback refilled cleared dates'; end if;

  -- Terminal state protects the current route from a later nonterminal snapshot.
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"IN_TRANSIT","origin":"AUH","destination":"JFK","eventWatermark":"2026-09-23T12:00:00Z","events":[]}', repeat('5',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000011';
  if v_row.status <> 'DELIVERED' or v_row.origin <> 'DXB' or v_row.destination <> 'LHR'
    or v_row.delivered_at <> '2026-09-21T12:00:00Z'::timestamptz then raise exception 'Nonterminal callback changed terminal route'; end if;
  -- A newer same-terminal correction may update endpoints, but cannot invent their actual dates.
  perform public.cargoai_apply_webhook('{"awb":"999-00000011","status":"DELIVERED","origin":"AUH","destination":"JFK","eventWatermark":"2026-09-24T12:00:00Z","events":[]}', repeat('6',64));
  select * into v_row from public.cargoai_shipments where awb = '999-00000011';
  if v_row.status <> 'DELIVERED' or v_row.origin <> 'AUH' or v_row.destination <> 'JFK'
    or v_row.departed_at is not null or v_row.arrived_at is not null or v_row.delivered_at is not null then raise exception 'Terminal endpoint correction retained stale dates'; end if;
  if has_function_privilege('authenticated', 'public.cargoai_claim_subscription(text,integer,boolean)', 'EXECUTE') then raise exception 'Browser role can claim credits'; end if;
  if has_table_privilege('authenticated', 'public.cargoai_shipments', 'INSERT') then raise exception 'Browser role can write tracking'; end if;
end;
$$;
rollback;
