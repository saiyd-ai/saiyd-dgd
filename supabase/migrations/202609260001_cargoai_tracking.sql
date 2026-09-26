-- Apply manually to the existing DGDOC Supabase project after review.
-- No browser role can read/write these tables or invoke these service-only RPCs.
-- This ledger only covers calls from this integration, not other use of the CargoAi key.

create table if not exists public.cargoai_shipments (
  awb text primary key check (awb ~ '^[0-9]{3}-[0-9]{8}$'),
  status text not null default 'UNKNOWN',
  origin text,
  destination text,
  flight text,
  departed_at timestamptz,
  arrived_at timestamptz,
  delivered_at timestamptz,
  last_update timestamptz,
  event_watermark timestamptz,
  events jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array'),
  subscription_status text not null default 'not_subscribed'
    check (subscription_status in ('not_subscribed', 'pending', 'unknown', 'active', 'expired', 'complete')),
  subscription_started_at timestamptz,
  subscription_expires_at timestamptz,
  claim_token uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.cargoai_credit_months (
  month date primary key,
  reserved_credits integer not null default 0 check (reserved_credits between 0 and 50)
);

create table if not exists public.cargoai_subscription_attempts (
  id uuid primary key,
  awb text not null references public.cargoai_shipments(awb),
  month date not null references public.cargoai_credit_months(month),
  credits integer not null default 10 check (credits = 10),
  outcome text not null default 'reserved' check (outcome in ('reserved', 'accepted', 'unknown')),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists cargoai_attempts_created_at_idx on public.cargoai_subscription_attempts(created_at desc);

create table if not exists public.cargoai_webhook_receipts (
  payload_hash text primary key check (payload_hash ~ '^[0-9a-f]{64}$'),
  awb text not null references public.cargoai_shipments(awb),
  received_at timestamptz not null default now()
);

alter table public.cargoai_shipments enable row level security;
alter table public.cargoai_credit_months enable row level security;
alter table public.cargoai_subscription_attempts enable row level security;
alter table public.cargoai_webhook_receipts enable row level security;
revoke all on public.cargoai_shipments, public.cargoai_credit_months,
  public.cargoai_subscription_attempts, public.cargoai_webhook_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.cargoai_shipments, public.cargoai_credit_months,
  public.cargoai_subscription_attempts, public.cargoai_webhook_receipts to service_role;

create or replace function public.cargoai_claim_subscription(p_awb text, p_budget integer, p_allow_renewals boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_shipment public.cargoai_shipments%rowtype;
  v_used integer;
  v_token uuid;
begin
  if p_budget is null or p_budget < 0 or p_budget > 50 then
    raise exception 'Free credit cap must be between 0 and 50';
  end if;
  if p_awb is null or p_awb !~ '^[0-9]{3}-[0-9]{8}$'
    or substring(p_awb from 5 for 7)::integer % 7 <> right(p_awb, 1)::integer then
    raise exception 'Invalid AWB';
  end if;
  -- One transaction serializes AWB claims, budget reservations, and the API rate gate.
  perform pg_catalog.pg_advisory_xact_lock(709260, 1);
  insert into public.cargoai_shipments(awb) values (p_awb) on conflict do nothing;
  select * into v_shipment from public.cargoai_shipments where awb = p_awb for update;
  if v_shipment.subscription_status in ('pending', 'unknown', 'complete') then
    return jsonb_build_object('claimed', false, 'reason', v_shipment.subscription_status);
  end if;
  if v_shipment.subscription_status = 'active' and v_shipment.subscription_expires_at > now() then
    return jsonb_build_object('claimed', false, 'reason', 'already_active');
  end if;
  if v_shipment.subscription_status in ('active', 'expired') then
    update public.cargoai_shipments set subscription_status = 'expired' where awb = p_awb;
    if p_allow_renewals is not true then
      return jsonb_build_object('claimed', false, 'reason', 'renewal_disabled');
    end if;
  end if;
  insert into public.cargoai_credit_months(month) values (v_month) on conflict do nothing;
  select reserved_credits into v_used from public.cargoai_credit_months where month = v_month for update;
  if v_used + 10 > p_budget then
    return jsonb_build_object('claimed', false, 'reason', 'budget_exhausted', 'reservedCredits', v_used);
  end if;
  if exists (select 1 from public.cargoai_subscription_attempts where created_at > now() - interval '30 seconds') then
    return jsonb_build_object('claimed', false, 'reason', 'rate_limited');
  end if;
  v_token := pg_catalog.gen_random_uuid();
  update public.cargoai_credit_months set reserved_credits = reserved_credits + 10 where month = v_month;
  insert into public.cargoai_subscription_attempts(id, awb, month) values (v_token, p_awb, v_month);
  update public.cargoai_shipments set subscription_status = 'pending', claim_token = v_token,
    subscription_started_at = now(), subscription_expires_at = null where awb = p_awb;
  return jsonb_build_object('claimed', true, 'claimToken', v_token, 'reservedCredits', v_used + 10);
end;
$$;

create or replace function public.cargoai_settle_subscription(p_claim_token uuid, p_accepted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.cargoai_subscription_attempts%rowtype;
begin
  select * into v_attempt from public.cargoai_subscription_attempts where id = p_claim_token for update;
  if not found then raise exception 'Unknown subscription claim'; end if;
  if v_attempt.outcome <> 'reserved' then return jsonb_build_object('settled', true); end if;
  update public.cargoai_subscription_attempts set outcome = case when p_accepted is true then 'accepted' else 'unknown' end,
    settled_at = now() where id = p_claim_token;
  update public.cargoai_shipments set
    subscription_status = case when subscription_status = 'complete' then 'complete'
      when p_accepted is true then 'active' else 'unknown' end,
    subscription_expires_at = case when p_accepted is true then v_attempt.created_at + interval '21 days' else null end
    where awb = v_attempt.awb and claim_token = p_claim_token;
  -- Never refund a reservation automatically: timeout/client errors may still be charged by CargoAi.
  return jsonb_build_object('settled', true);
end;
$$;

create or replace function public.cargoai_apply_webhook(p_shipment jsonb, p_payload_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_awb text := p_shipment->>'awb';
  v_shipment public.cargoai_shipments%rowtype;
  v_count integer;
  v_events jsonb;
  v_watermark timestamptz := (p_shipment->>'eventWatermark')::timestamptz;
  v_fresh boolean;
  v_newer boolean;
  v_status_allowed boolean;
  v_old_rank integer;
  v_new_rank integer;
  v_terminal boolean;
  v_replace boolean;
  v_same_route boolean;
  v_status text;
  v_origin text;
  v_destination text;
  v_flight text;
  v_departed timestamptz;
  v_arrived timestamptz;
  v_delivered timestamptz;
begin
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid payload hash'; end if;
  select * into v_shipment from public.cargoai_shipments where awb = v_awb for update;
  -- Even a valid vendor signature cannot inject arbitrary AWBs into the company tracking ledger.
  if not found or v_shipment.claim_token is null then return jsonb_build_object('ignored', true); end if;
  insert into public.cargoai_webhook_receipts(payload_hash, awb) values (p_payload_hash, v_awb) on conflict do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then return jsonb_build_object('duplicate', true); end if;
  -- A callback has no provider-wide timestamp. Confirmed operational event dates are
  -- the conservative ordering watermark. Future/planned/predicted dates are excluded upstream.
  -- Older snapshots may enrich history but cannot replace a newer summary.
  -- Undated/equal snapshots may advance explicit provider status while keeping existing dates.
  v_fresh := v_watermark is null or v_shipment.event_watermark is null or v_watermark >= v_shipment.event_watermark;
  v_newer := v_watermark is not null and (v_shipment.event_watermark is null or v_watermark > v_shipment.event_watermark);
  v_terminal := v_shipment.subscription_status = 'complete';
  -- Equal/undated callbacks may advance a provider status but may not regress it.
  -- A strictly newer actual watermark may carry a legitimate nonterminal correction/rebooking.
  v_old_rank := case v_shipment.status when 'PENDING_DELIVERY' then 1 when 'IN_TRANSIT' then 2
    when 'AT_DESTINATION' then 3 when 'DELIVERED' then 4 when 'CANCELLED' then 5 when 'CANCELED' then 5 else 0 end;
  v_new_rank := case p_shipment->>'status' when 'PENDING_DELIVERY' then 1 when 'IN_TRANSIT' then 2
    when 'AT_DESTINATION' then 3 when 'DELIVERED' then 4 when 'CANCELLED' then 5 when 'CANCELED' then 5 else 0 end;
  v_status_allowed := v_fresh and (v_newer or p_shipment->>'status' = v_shipment.status
    or v_shipment.status = 'UNKNOWN' or (v_new_rank > v_old_rank))
    and (not v_terminal or p_shipment->>'status' = v_shipment.status);
  v_replace := v_status_allowed and (v_newer or v_shipment.event_watermark is null);
  v_same_route := p_shipment->>'origin' = v_shipment.origin and p_shipment->>'destination' = v_shipment.destination;
  select coalesce(jsonb_agg(value order by value->>'eventDate', value->>'code'), '[]'::jsonb) into v_events
    from (select distinct value from jsonb_array_elements(v_shipment.events || coalesce(p_shipment->'events', '[]'::jsonb))) merged;
  v_status := case when v_status_allowed then coalesce(nullif(p_shipment->>'status', ''), v_shipment.status) else v_shipment.status end;
  v_origin := case when v_replace then coalesce(p_shipment->>'origin', v_shipment.origin) else v_shipment.origin end;
  v_destination := case when v_replace then coalesce(p_shipment->>'destination', v_shipment.destination) else v_shipment.destination end;
  v_flight := case when v_replace then coalesce(p_shipment->>'flight', v_shipment.flight) else v_shipment.flight end;
  -- Endpoint-specific dates cannot be carried across an accepted routing correction.
  -- The fresh payload must establish a date for the new endpoint, otherwise leave it unknown.
  v_departed := case when v_replace and v_origin is distinct from v_shipment.origin then (p_shipment->>'departedAt')::timestamptz
    when v_replace then coalesce((p_shipment->>'departedAt')::timestamptz, v_shipment.departed_at)
    when v_same_route then coalesce(v_shipment.departed_at, (p_shipment->>'departedAt')::timestamptz) else v_shipment.departed_at end;
  v_arrived := case when v_replace and v_destination is distinct from v_shipment.destination then (p_shipment->>'arrivedAt')::timestamptz
    when v_replace then coalesce((p_shipment->>'arrivedAt')::timestamptz, v_shipment.arrived_at)
    when v_same_route then coalesce(v_shipment.arrived_at, (p_shipment->>'arrivedAt')::timestamptz) else v_shipment.arrived_at end;
  v_delivered := case when v_replace and v_destination is distinct from v_shipment.destination then (p_shipment->>'deliveredAt')::timestamptz
    when v_replace then coalesce((p_shipment->>'deliveredAt')::timestamptz, v_shipment.delivered_at)
    when v_same_route and v_status = 'DELIVERED' then coalesce(v_shipment.delivered_at, (p_shipment->>'deliveredAt')::timestamptz) else v_shipment.delivered_at end;
  update public.cargoai_shipments set
    status = v_status, origin = v_origin, destination = v_destination, flight = v_flight,
    departed_at = v_departed, arrived_at = v_arrived, delivered_at = v_delivered,
    last_update = case when row(status, origin, destination, flight, departed_at, arrived_at, delivered_at, events)
      is distinct from row(v_status, v_origin, v_destination, v_flight, v_departed, v_arrived, v_delivered, v_events) then now() else last_update end,
    event_watermark = greatest(event_watermark, v_watermark),
    events = v_events,
    subscription_status = case when v_status in ('DELIVERED', 'CANCELLED', 'CANCELED') then 'complete' else subscription_status end
    where awb = v_awb;
  return jsonb_build_object('updated', true);
end;
$$;

revoke all on function public.cargoai_claim_subscription(text, integer, boolean) from public, anon, authenticated;
revoke all on function public.cargoai_settle_subscription(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cargoai_apply_webhook(jsonb, text) from public, anon, authenticated;
grant execute on function public.cargoai_claim_subscription(text, integer, boolean) to service_role;
grant execute on function public.cargoai_settle_subscription(uuid, boolean) to service_role;
grant execute on function public.cargoai_apply_webhook(jsonb, text) to service_role;
