begin;

create table public.pd_chief_term_snapshot (
  id smallint primary key check (id=1),
  updated_at timestamptz not null,
  entries jsonb not null check (jsonb_typeof(entries)='array' and jsonb_array_length(entries)<=4)
);
alter table public.pd_chief_term_snapshot enable row level security;
revoke all on public.pd_chief_term_snapshot from public,anon,authenticated;
grant select on public.pd_chief_term_snapshot to anon,authenticated;
grant select,insert,update on public.pd_chief_term_snapshot to service_role;
create policy pd_chief_term_snapshot_read on public.pd_chief_term_snapshot
  for select to anon,authenticated using (id=1);

create function public.pd_store_chief_term_snapshot(p_updated_at timestamptz,p_entries jsonb)
returns void
language sql security invoker set search_path=''
as $$
  insert into public.pd_chief_term_snapshot as previous(id,updated_at,entries)
  values(1,p_updated_at,p_entries)
  on conflict(id) do update set updated_at=excluded.updated_at,entries=excluded.entries
  where previous.updated_at<excluded.updated_at;
$$;
revoke all on function public.pd_store_chief_term_snapshot(timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.pd_store_chief_term_snapshot(timestamptz,jsonb) to service_role;

create table public.pd_chief_term_sync_auth (
  id smallint primary key check (id=1),
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$')
);
alter table public.pd_chief_term_sync_auth enable row level security;
revoke all on public.pd_chief_term_sync_auth from public,anon,authenticated,service_role;
grant select on public.pd_chief_term_sync_auth to service_role;
create policy pd_chief_term_sync_service_read on public.pd_chief_term_sync_auth
  for select to service_role using (id=1);

select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''),
  'pd_chief_term_sync_token',
  'Authorizes the scheduled import of chief terms from Google Sheets'
);
insert into public.pd_chief_term_sync_auth(id,token_sha256)
select 1,encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex')
from vault.decrypted_secrets where name='pd_chief_term_sync_token';

select cron.schedule('pd-sync-chief-terms','*/10 * * * *',$job$
  select net.http_post(
    url := 'https://pbwgvyhchpzmgqjyqxzv.supabase.co/functions/v1/pd-sync-chief-terms',
    headers := jsonb_build_object('Content-Type','application/json','x-pd-sync-token',decrypted_secret),
    timeout_milliseconds := 30000
  ) from vault.decrypted_secrets where name='pd_chief_term_sync_token';
$job$);

notify pgrst, 'reload schema';
commit;
