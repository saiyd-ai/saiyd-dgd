-- v25.11-N AI COST per job: every AI call logged (tokens + USD + AED); staff insert own rows, only the owner reads
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  user_email text default (auth.jwt() ->> 'email'),
  job_no text,
  feature text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  rate_in_usd numeric not null default 0,
  rate_out_usd numeric not null default 0,
  cost_usd numeric not null default 0,
  cost_aed numeric not null default 0
);
create index if not exists ai_usage_job_idx on public.ai_usage (job_no);
create index if not exists ai_usage_created_idx on public.ai_usage (created_at desc);
alter table public.ai_usage enable row level security;
create policy "ai_usage insert own" on public.ai_usage for insert to authenticated with check (user_id = auth.uid());
create policy "ai_usage read owner" on public.ai_usage for select to authenticated using ((auth.jwt() ->> 'email') = 'ms@jfslogistics.com');
create policy "ai_usage delete owner" on public.ai_usage for delete to authenticated using ((auth.jwt() ->> 'email') = 'ms@jfslogistics.com');
