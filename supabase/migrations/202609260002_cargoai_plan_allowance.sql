-- Additive upgrade after 202609260001; does not activate tracking or change server configuration.
-- Apply before deploying the server that supplies p_plan_allowance. Old callers remain capped at 50.
begin;

alter table public.cargoai_credit_months
  drop constraint cargoai_credit_months_reserved_credits_check,
  add constraint cargoai_credit_months_reserved_credits_check check (reserved_credits between 0 and 3000);

create or replace function public.cargoai_claim_subscription(
  p_awb text, p_budget integer, p_allow_renewals boolean, p_plan_allowance integer
)
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
  if p_plan_allowance is null or p_plan_allowance < 0 or p_plan_allowance > 3000
    or p_budget is null or p_budget < 0 or p_budget > p_plan_allowance then
    raise exception 'Credit cap must be within the configured plan allowance (maximum 3000)';
  end if;
  if p_awb is null or p_awb !~ '^[0-9]{3}-[0-9]{8}$'
    or substring(p_awb from 5 for 7)::integer % 7 <> right(p_awb, 1)::integer then
    raise exception 'Invalid AWB';
  end if;
  -- This shared transaction lock preserves claim deduplication, budget and rate gates for both RPC versions.
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

-- Keep already-deployed callers working without allowing them to infer a paid allowance.
create or replace function public.cargoai_claim_subscription(p_awb text, p_budget integer, p_allow_renewals boolean default false)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.cargoai_claim_subscription(p_awb, p_budget, p_allow_renewals, 50);
$$;

revoke all on function public.cargoai_claim_subscription(text, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.cargoai_claim_subscription(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.cargoai_claim_subscription(text, integer, boolean, integer) to service_role;
grant execute on function public.cargoai_claim_subscription(text, integer, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
