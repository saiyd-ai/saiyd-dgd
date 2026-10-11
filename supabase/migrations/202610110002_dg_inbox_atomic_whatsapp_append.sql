-- Apply before deploying the expanded dg-inbox function. Existing inbox rows,
-- status and notes remain intact. Only the Edge Function service role may append.
alter table public.dg_inbox
  add column if not exists wa_message_ids text[] not null default '{}';

create or replace function public.dg_inbox_append_whatsapp(
  p_id uuid,
  p_sender text,
  p_job_no text,
  p_text text,
  p_file jsonb,
  p_message_id text,
  p_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.dg_inbox%rowtype;
begin
  -- The lock serializes a burst of documents/text for this job. Build each
  -- append from current database state, never the function caller's snapshot.
  select * into current_row
  from public.dg_inbox
  where id = p_id and sender = p_sender
  for update;
  if not found then raise exception 'Inbox row not found'; end if;
  if coalesce(current_row.status, '') not in ('NEW', 'OPENED')
     or current_row.updated_at < p_at - interval '120 minutes' then
    raise exception 'Inbox row is no longer active';
  end if;
  if p_job_no is not null and current_row.job_no is not null
     and current_row.job_no <> p_job_no then
    raise exception 'Inbox job mismatch';
  end if;
  if p_at is null or p_sender is null
     or length(coalesce(p_text, '')) > 65536
     or (p_message_id is not null and
         (length(p_message_id) = 0 or length(p_message_id) > 512 or p_message_id ~ '[[:space:]]')) then
    raise exception 'Invalid WhatsApp append';
  end if;
  if p_file is not null and
     (jsonb_typeof(p_file) <> 'object' or coalesce(p_file->>'path', '') = '') then
    raise exception 'Invalid file metadata';
  end if;
  if p_message_id is not null and p_message_id = any(current_row.wa_message_ids) then
    return jsonb_build_object('row', to_jsonb(current_row), 'duplicate', true);
  end if;

  update public.dg_inbox
  set job_no = coalesce(current_row.job_no, p_job_no),
      message = case when coalesce(p_text, '') = '' then current_row.message
        when coalesce(current_row.message, '') = '' then p_text
        else current_row.message || E'\n' || p_text end,
      files = case when p_file is null then current_row.files
        else (case when jsonb_typeof(current_row.files) = 'array' then current_row.files else '[]'::jsonb end)
          || jsonb_build_array(p_file) end,
      wa_message_ids = case when p_message_id is null then current_row.wa_message_ids
        else array_append(current_row.wa_message_ids, p_message_id) end,
      updated_at = greatest(current_row.updated_at, p_at)
  where id = current_row.id
  returning * into current_row;
  return jsonb_build_object('row', to_jsonb(current_row), 'duplicate', false);
end;
$$;

revoke all on function public.dg_inbox_append_whatsapp(uuid,text,text,text,jsonb,text,timestamptz) from public, anon, authenticated;
grant execute on function public.dg_inbox_append_whatsapp(uuid,text,text,text,jsonb,text,timestamptz) to service_role;
