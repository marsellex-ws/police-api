begin;

create table public.pd_theft_portal_snapshot (
  section text primary key check (section in ('current','archive','police')),
  updated_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
alter table public.pd_theft_portal_snapshot enable row level security;
revoke all on public.pd_theft_portal_snapshot from public, anon, authenticated;
grant select on public.pd_theft_portal_snapshot to anon, authenticated;
grant select, insert, update on public.pd_theft_portal_snapshot to service_role;
create policy pd_theft_portal_snapshot_read on public.pd_theft_portal_snapshot
  for select to anon, authenticated using (true);

create function public.pd_store_theft_portal(p_section text, p_updated_at timestamptz, p_payload jsonb)
returns void
language sql security invoker set search_path = ''
as $$
  insert into public.pd_theft_portal_snapshot as previous(section,updated_at,payload)
  values(p_section,p_updated_at,p_payload)
  on conflict(section) do update set updated_at=excluded.updated_at,payload=excluded.payload
  where previous.updated_at < excluded.updated_at;
$$;
revoke all on function public.pd_store_theft_portal(text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.pd_store_theft_portal(text,timestamptz,jsonb) to service_role;

-- Only the filtered page is transferred to the browser.
create function public.pd_public_theft_history(p_search text default '', p_offset integer default 0)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'updated_at', snapshot.updated_at,
    'items', coalesce(jsonb_agg(page.entry order by page.position) filter (where page.row_number<=40), '[]'::jsonb),
    'has_more', count(page.entry)>40
  )
  from public.pd_theft_portal_snapshot snapshot
  left join lateral (
    select selected.*, row_number() over(order by selected.position) as row_number
    from (
      select entry, position
      from jsonb_array_elements(snapshot.payload->'history') with ordinality as history(entry,position)
      where strpos(lower(entry->>'name'),lower(left(btrim(coalesce(p_search,'')),80)))>0
         or strpos(entry->>'account',left(btrim(coalesce(p_search,'')),80))>0
      order by position limit 41 offset greatest(0,least(coalesce(p_offset,0),200000))
    ) selected
  ) page on true
  where snapshot.section='archive'
  group by snapshot.updated_at;
$$;
revoke all on function public.pd_public_theft_history(text,integer) from public;
grant execute on function public.pd_public_theft_history(text,integer) to anon, authenticated;

-- The existing five-minute job still refreshes historical data and rankings.
select cron.schedule('pd-sync-current-theft','* * * * *',$job$
  select net.http_post(
    url := 'https://pbwgvyhchpzmgqjyqxzv.supabase.co/functions/v1/pd-sync-thefts',
    headers := jsonb_build_object('Content-Type','application/json','x-pd-sync-token',decrypted_secret),
    body := '{"kind":"current"}'::jsonb,
    timeout_milliseconds := 30000
  ) from vault.decrypted_secrets where name='pd_employee_theft_sync_token';
$job$);

notify pgrst, 'reload schema';
commit;
