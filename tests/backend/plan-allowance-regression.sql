-- Run only in an empty, disposable development database after BOTH migrations.
-- This is a rollback-only SQL integration test; it never calls CargoAi.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';

do $$
declare
  v_result jsonb;
  v_rejected boolean;
  v_case record;
  v_i integer;
  v_awb text;
begin
  if exists(select 1 from public.cargoai_subscription_attempts)
    or exists(select 1 from public.cargoai_shipments)
    or exists(select 1 from public.cargoai_credit_months)
    or exists(select 1 from public.cargoai_webhook_receipts) then
    raise exception 'Use an empty disposable tracking database';
  end if;

  -- Every invalid allowance/cap pair must fail before reserving credits.
  for v_case in select * from (values (51,50), (151,150), (3001,3000), (10,3001),
    (-1,50), (10,-1), (10,null::integer), (null::integer,50)) as cases(budget,allowance) loop
    v_rejected := false;
    begin
      perform public.cargoai_claim_subscription('999-00000011', v_case.budget, false, v_case.allowance);
    exception when raise_exception then v_rejected := true;
    end;
    if not v_rejected then raise exception 'Invalid cap/allowance pair accepted'; end if;
  end loop;
  v_rejected := false;
  begin
    perform public.cargoai_claim_subscription('999-00000011', 60, false);
  exception when raise_exception then v_rejected := true;
  end;
  if not v_rejected then raise exception 'Legacy caller bypassed default 50 allowance'; end if;
  v_result := public.cargoai_claim_subscription('999-00000011', 0, false, 150);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception 'Paid allowance enabled a zero cap'; end if;

  -- Bronze allowance permits exactly 15 standard 10-credit reservations.
  for v_i in 1..15 loop
    update public.cargoai_subscription_attempts set created_at = now() - interval '31 seconds';
    v_awb := '999-' || lpad(v_i::text, 7, '0') || (v_i % 7)::text;
    v_result := public.cargoai_claim_subscription(v_awb, 150, false, 150);
    if v_result->>'claimed' <> 'true' then raise exception 'Expected Bronze claim %', v_i; end if;
    perform public.cargoai_settle_subscription((v_result->>'claimToken')::uuid, v_i <> 2);
    v_result := public.cargoai_claim_subscription(v_awb, 150, false, 150);
    if v_result->>'claimed' <> 'false' then raise exception 'Paid duplicate/unknown request retried'; end if;
  end loop;
  if (select sum(reserved_credits) from public.cargoai_credit_months) <> 150 then raise exception 'Wrong Bronze reserved credits'; end if;
  v_result := public.cargoai_claim_subscription('999-00000162', 150, false, 150);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception 'Bronze cap bypassed'; end if;
  v_result := public.cargoai_claim_subscription('999-00000162', 50, false);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception 'Allowance downgrade reset the existing ledger'; end if;

  -- Exercise the absolute upper boundary without creating hundreds of fixture shipments.
  update public.cargoai_credit_months set reserved_credits = 2990;
  update public.cargoai_subscription_attempts set created_at = now() - interval '31 seconds';
  v_result := public.cargoai_claim_subscription('999-00000162', 3000, false, 3000);
  if v_result->>'claimed' <> 'true' or v_result->>'reservedCredits' <> '3000' then raise exception '3000-credit boundary incorrect'; end if;
  v_result := public.cargoai_claim_subscription('999-00000173', 3000, false, 3000);
  if v_result->>'reason' <> 'budget_exhausted' then raise exception 'Absolute cap bypassed'; end if;
  v_rejected := false;
  begin
    update public.cargoai_credit_months set reserved_credits = 3001;
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'Table permits credits above absolute ceiling'; end if;

  if has_function_privilege('anon', 'public.cargoai_claim_subscription(text,integer,boolean,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.cargoai_claim_subscription(text,integer,boolean,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.cargoai_claim_subscription(text,integer,boolean)', 'EXECUTE') then
    raise exception 'Browser role can claim credits';
  end if;
  if not has_function_privilege('service_role', 'public.cargoai_claim_subscription(text,integer,boolean,integer)', 'EXECUTE') then
    raise exception 'Server role cannot use explicit allowance';
  end if;
end;
$$;
rollback;
