-- SKYD AWB drafts are versioned separately from manually approved documents.
create table if not exists public.skyd_awb_runs (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid references public.dg_inbox(id) on delete set null,
  job_no text not null, sender text not null check(sender = '971562977774'),
  version integer not null check(version > 0), request_message_id text not null,
  status text not null check(status in ('PROCESSING','NEEDS_INPUT','DRAFT_READY','FAILED')),
  source_snapshot jsonb not null, fields jsonb not null default '{}', evidence jsonb not null default '{}',
  warnings jsonb not null default '[]', missing_fields jsonb not null default '[]', artifact_path text,
  ai_usage jsonb not null default '{}',
  processing_token uuid not null default gen_random_uuid(), error_code text,
  delivery_status text not null default 'NOT_SENT' check(delivery_status in ('NOT_SENT','CLAIMED','SENT','UNCERTAIN')),
  delivery_claim_token uuid, delivery_claimed_at timestamptz, meta_message_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(sender,request_message_id), unique(sender,job_no,version)
);
alter table public.skyd_awb_runs enable row level security;
drop policy if exists "skyd drafts active staff read" on public.skyd_awb_runs;
create policy "skyd drafts active staff read" on public.skyd_awb_runs for select to authenticated
  using(exists(select 1 from public.profiles p where p.user_id = auth.uid() and p.active = true));
revoke all on public.skyd_awb_runs from anon, authenticated;
-- Active DGDOC staff can review drafts, not read worker claim tokens, AI usage,
-- provider request IDs, or immutable private preparation source snapshots.
grant select(id,inbox_id,job_no,version,status,fields,warnings,missing_fields,artifact_path,error_code,created_at,delivery_status)
  on public.skyd_awb_runs to authenticated;
grant all on public.skyd_awb_runs to service_role;

create or replace function public.skyd_awb_claim_prepare(p_sender text,p_job_no text,p_message_id text,p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.skyd_awb_runs%rowtype; inbox public.dg_inbox%rowtype; next_version integer;
begin
  if p_sender <> '971562977774' or p_sender is null or p_at is null or p_job_no !~ '^[A-Z]{2,5}-C[0-9]{3,8}$'
    or p_job_no is null or p_message_id is null or length(p_message_id) not between 1 and 512 or p_message_id ~ '[[:space:]]' then raise exception 'Invalid preparation request'; end if;
  -- Lock the sender, not just the job, so reusing one message ID across two jobs
  -- cannot race the unique idempotency constraint.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('skyd_prepare:' || p_sender,0));
  select * into r from public.skyd_awb_runs where sender=p_sender and request_message_id=p_message_id;
  if found then
    if r.job_no <> p_job_no then return jsonb_build_object('error','MESSAGE_JOB_MISMATCH'); end if;
    return jsonb_build_object('row',to_jsonb(r),'created',false);
  end if;
  select * into inbox from public.dg_inbox where sender=p_sender and job_no=p_job_no and status in ('NEW','OPENED')
    order by updated_at desc,created_at desc,id limit 1 for share;
  if not found then return jsonb_build_object('error','JOB_NOT_FOUND'); end if;
  select coalesce(max(version),0)+1 into next_version from public.skyd_awb_runs where sender=p_sender and job_no=p_job_no;
  insert into public.skyd_awb_runs(inbox_id,job_no,sender,version,request_message_id,status,source_snapshot,created_at,updated_at)
  values(inbox.id,p_job_no,p_sender,next_version,p_message_id,'PROCESSING',
    jsonb_build_object('inbox_id',inbox.id,'job_no',inbox.job_no,'message',inbox.message,'files',inbox.files,'note',inbox.note,'captured_at',p_at),p_at,p_at)
  returning * into r;
  return jsonb_build_object('row',to_jsonb(r),'created',true);
end; $$;

create or replace function public.skyd_awb_finish_prepare(p_run_id uuid,p_token uuid,p_status text,p_fields jsonb,p_evidence jsonb,p_warnings jsonb,p_missing_fields jsonb,p_artifact_path text,p_error_code text,p_ai_usage jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.skyd_awb_runs%rowtype; expected_path text;
begin
  select * into r from public.skyd_awb_runs where id=p_run_id and processing_token=p_token for update;
  if not found or r.status <> 'PROCESSING' then raise exception 'Preparation claim unavailable'; end if;
  if p_status is null or p_status not in ('NEEDS_INPUT','DRAFT_READY','FAILED') or coalesce(jsonb_typeof(p_fields),'null')<>'object' or coalesce(jsonb_typeof(p_evidence),'null')<>'object'
    or coalesce(jsonb_typeof(p_warnings),'null')<>'array' or coalesce(jsonb_typeof(p_missing_fields),'null')<>'array' or coalesce(jsonb_typeof(p_ai_usage),'null')<>'object' then raise exception 'Invalid preparation result'; end if;
  expected_path='skyd-awb/' || r.inbox_id::text || '/v' || r.version::text || '-' || r.id::text || '.pdf';
  if p_status='DRAFT_READY' and (r.inbox_id is null or p_artifact_path is null or p_artifact_path<>expected_path or jsonb_array_length(p_missing_fields)>0) then raise exception 'Invalid draft artifact'; end if;
  if p_status<>'DRAFT_READY' and p_artifact_path is not null then raise exception 'Unexpected draft artifact'; end if;
  update public.skyd_awb_runs set status=p_status,fields=p_fields,evidence=p_evidence,warnings=p_warnings,missing_fields=p_missing_fields,
    artifact_path=p_artifact_path,error_code=p_error_code,ai_usage=p_ai_usage,updated_at=now() where id=r.id returning * into r;
  return jsonb_build_object('row',to_jsonb(r));
end; $$;

create or replace function public.skyd_awb_claim_delivery(p_run_id uuid,p_sender text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.skyd_awb_runs%rowtype;
begin
  if p_sender is null or p_sender <> '971562977774' then raise exception 'Owner only'; end if;
  select * into r from public.skyd_awb_runs where id=p_run_id and sender=p_sender for update;
  if not found or r.status<>'DRAFT_READY' or r.artifact_path is null then raise exception 'Draft unavailable'; end if;
  if r.delivery_status<>'NOT_SENT' then return jsonb_build_object('row',to_jsonb(r),'claimed',false); end if;
  update public.skyd_awb_runs set delivery_status='CLAIMED',delivery_claim_token=gen_random_uuid(),delivery_claimed_at=now(),updated_at=now()
    where id=r.id returning * into r;
  return jsonb_build_object('row',to_jsonb(r),'claimed',true);
end; $$;

create or replace function public.skyd_awb_finish_delivery(p_run_id uuid,p_sender text,p_token uuid,p_meta_message_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.skyd_awb_runs%rowtype;
begin
  if p_sender is null or p_sender <> '971562977774' then raise exception 'Owner only'; end if;
  select * into r from public.skyd_awb_runs where id=p_run_id and sender=p_sender and delivery_claim_token=p_token for update;
  if not found then raise exception 'Delivery claim unavailable'; end if;
  if r.delivery_status='SENT' and r.meta_message_id=p_meta_message_id then return jsonb_build_object('row',to_jsonb(r)); end if;
  if r.delivery_status<>'CLAIMED' then raise exception 'Delivery already resolved'; end if;
  if p_meta_message_id is not null and (length(p_meta_message_id) not between 1 and 512 or p_meta_message_id ~ '[[:space:]]') then raise exception 'Invalid Meta proof'; end if;
  update public.skyd_awb_runs set delivery_status=case when p_meta_message_id is null then 'UNCERTAIN' else 'SENT' end,
    meta_message_id=p_meta_message_id,updated_at=now() where id=r.id returning * into r;
  return jsonb_build_object('row',to_jsonb(r));
end; $$;

revoke all on function public.skyd_awb_claim_prepare(text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.skyd_awb_finish_prepare(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.skyd_awb_claim_delivery(uuid,text) from public,anon,authenticated;
revoke all on function public.skyd_awb_finish_delivery(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.skyd_awb_claim_prepare(text,text,text,timestamptz) to service_role;
grant execute on function public.skyd_awb_finish_prepare(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,jsonb) to service_role;
grant execute on function public.skyd_awb_claim_delivery(uuid,text) to service_role;
grant execute on function public.skyd_awb_finish_delivery(uuid,text,uuid,text) to service_role;
