begin;

create table public.pd_theft_snapshot (
  id smallint primary key check (id = 1),
  updated_at timestamptz not null,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and
    payload @> '{"ok":true}'::jsonb and
    payload ? 'periods'
  )
);

alter table public.pd_theft_snapshot enable row level security;
revoke all on public.pd_theft_snapshot from public, anon, authenticated;
grant select (id, payload) on public.pd_theft_snapshot to anon, authenticated;
grant select, insert, update on public.pd_theft_snapshot to service_role;

create policy pd_theft_snapshot_public_read on public.pd_theft_snapshot
  for select to anon, authenticated using (id = 1);

create function public.pd_store_theft_snapshot(p_payload jsonb)
returns void
language sql security invoker set search_path = ''
as $$
  insert into public.pd_theft_snapshot as previous (id, updated_at, payload)
  values (1, (p_payload ->> 'updated_at')::timestamptz, p_payload)
  on conflict (id) do update
    set updated_at = excluded.updated_at, payload = excluded.payload
    where previous.updated_at < excluded.updated_at;
$$;

revoke all on function public.pd_store_theft_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.pd_store_theft_snapshot(jsonb) to service_role;

create table public.pd_theft_sync_auth (
  id smallint primary key check (id = 1),
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$')
);

alter table public.pd_theft_sync_auth enable row level security;
revoke all on public.pd_theft_sync_auth from public, anon, authenticated, service_role;
grant select on public.pd_theft_sync_auth to service_role;
create policy pd_theft_sync_service_read on public.pd_theft_sync_auth
  for select to service_role using (id = 1);

select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'pd_employee_theft_sync_token',
  'Authorizes Supabase Cron to run the employee theft archive sync'
);

insert into public.pd_theft_sync_auth (id, token_sha256)
select 1, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(decrypted_secret, 'UTF8')), 'hex')
from vault.decrypted_secrets
where name = 'pd_employee_theft_sync_token';

create extension if not exists pg_net with schema extensions;
revoke usage on schema net from public, anon, authenticated;

select cron.schedule('pd-sync-employee-thefts', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://pbwgvyhchpzmgqjyqxzv.supabase.co/functions/v1/pd-sync-thefts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pd-sync-token', decrypted_secret),
    timeout_milliseconds := 35000
  )
  from vault.decrypted_secrets
  where name = 'pd_employee_theft_sync_token';
$job$);

notify pgrst, 'reload schema';
commit;
