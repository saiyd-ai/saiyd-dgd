-- v25.11-T WhatsApp → DGDOC inbox (already applied via MCP on 2026-10-11)
create table if not exists public.dg_inbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_no text, sender text not null, sender_name text, message text,
  files jsonb not null default '[]'::jsonb,
  status text not null default 'NEW', opened_by text, opened_at timestamptz, note text
);
create index if not exists dg_inbox_sender_idx on public.dg_inbox (sender, updated_at desc);
create index if not exists dg_inbox_status_idx on public.dg_inbox (status, created_at desc);
alter table public.dg_inbox enable row level security;
create policy "dg_inbox read staff" on public.dg_inbox for select to authenticated using (true);
create policy "dg_inbox update staff" on public.dg_inbox for update to authenticated using (true) with check (true);
create policy "dg_inbox delete owner" on public.dg_inbox for delete to authenticated using ((auth.jwt() ->> 'email') = 'ms@jfslogistics.com');
create table if not exists public.dg_staff_numbers (
  phone text primary key, name text, active boolean not null default true, created_at timestamptz not null default now()
);
alter table public.dg_staff_numbers enable row level security;
create policy "dg_staff read" on public.dg_staff_numbers for select to authenticated using (true);
create policy "dg_staff write owner" on public.dg_staff_numbers for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ms@jfslogistics.com') with check ((auth.jwt() ->> 'email') = 'ms@jfslogistics.com');
create table if not exists public.dg_inbox_config (key text primary key, value text not null);
alter table public.dg_inbox_config enable row level security;  -- no policies: service role only
insert into public.dg_inbox_config(key, value) values ('n8n_key', encode(gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
