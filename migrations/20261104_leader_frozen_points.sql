-- Apply once in the existing Police API Supabase project (SQL Editor).
-- No balances change until an administrator explicitly performs a thaw.
begin;
create table if not exists public.pd_quest_leader_frozen (
 id uuid primary key default gen_random_uuid(),
 source_history_id text not null unique,
 department text not null check (department in ('LSPD','SFPD','LVPD')),
 nickname text not null,
 amount numeric(12,2) not null check (amount > 0 and amount <= 400),
 status text not null default 'frozen' check (status in ('frozen','thawed')),
 imported_by text not null,
 created_at timestamptz not null default now(),
 thawed_by text,
 thawed_at timestamptz,
 target_login text,
 balance_before numeric,
 balance_after numeric,
 constraint frozen_thaw_audit check (
  (status='frozen' and thawed_by is null and thawed_at is null and target_login is null and balance_before is null and balance_after is null)
  or (status='thawed' and thawed_by is not null and thawed_at is not null and target_login is not null and balance_before is not null and balance_after=balance_before+amount)
 )
);
create index if not exists pd_quest_leader_frozen_department_idx on public.pd_quest_leader_frozen(department,created_at desc);
alter table public.pd_quest_leader_frozen enable row level security;
revoke all on public.pd_quest_leader_frozen from public,anon,authenticated;
grant select on public.pd_quest_leader_frozen to service_role;

create or replace function public.pd_quest_import_leader_freeze(p_history_id text,p_amount numeric,p_actor text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_history public.pd_quest_legacy_history%rowtype; v_item public.pd_quest_leader_frozen%rowtype;
begin
 perform 1 from public.pd_ws_roles where login=p_actor and role in ('admin','developer') for share;
 if not found then return jsonb_build_object('ok',false,'status',403,'error','Разрешено только администратору или разработчику'); end if;
 if p_amount is null or p_amount<=0 or p_amount>400 or p_amount<>round(p_amount,2) then
  return jsonb_build_object('ok',false,'status',400,'error','Сумма заморозки шефа: от 0,01 до 400 баллов');
 end if;
 select * into v_history from public.pd_quest_legacy_history where id::text=p_history_id for update;
 if not found then return jsonb_build_object('ok',false,'status',404,'error','Архивная строка не найдена'); end if;
 if v_history.track is distinct from 'leader' or v_history.department is null or v_history.department not in ('LSPD','SFPD','LVPD')
  or nullif(btrim(v_history.nickname),'') is null or coalesce(v_history.description,'') !~* 'замороз'
  or coalesce(v_history.description,'') ~* 'размороз'
  or lower(coalesce(v_history.source_data->'values'->>7,'')) in ('true','да','1') then
  return jsonb_build_object('ok',false,'status',409,'error','Строка не является действующей заморозкой шефа');
 end if;
 insert into public.pd_quest_leader_frozen(source_history_id,department,nickname,amount,imported_by)
 values(p_history_id,v_history.department,btrim(v_history.nickname),p_amount,p_actor)
 on conflict(source_history_id) do nothing returning * into v_item;
 if not found then return jsonb_build_object('ok',false,'status',409,'error','Эта заморозка уже учтена'); end if;
 return jsonb_build_object('ok',true,'item',to_jsonb(v_item));
end $$;

create or replace function public.pd_quest_thaw_leader_points(p_id uuid,p_target_login text,p_actor text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_item public.pd_quest_leader_frozen%rowtype; v_role public.pd_ws_roles%rowtype;
 v_nickname text; v_member_id uuid; v_before numeric; v_after numeric; v_result jsonb; v_count integer;
begin
 perform 1 from public.pd_ws_roles where login=p_actor and role in ('admin','developer') for share;
 if not found then return jsonb_build_object('ok',false,'status',403,'error','Разрешено только администратору или разработчику'); end if;
 select * into v_item from public.pd_quest_leader_frozen where id=p_id;
 if not found then return jsonb_build_object('ok',false,'status',404,'error','Заморозка не найдена'); end if;
 perform 1 from public.pd_quest_legacy_history where id::text=v_item.source_history_id and lower(coalesce(source_data->'values'->>7,'')) not in ('true','да','1') for update;
 if not found then return jsonb_build_object('ok',false,'status',409,'error','Архивная заморозка отсутствует или уже использована'); end if;
 select * into v_item from public.pd_quest_leader_frozen where id=p_id for update;
 if v_item.status<>'frozen' then return jsonb_build_object('ok',false,'status',409,'error','Баллы уже разморожены'); end if;
 select * into v_role from public.pd_ws_roles where login=lower(btrim(p_target_login)) for share;
 if not found or v_role.role is distinct from 'leader' or v_role.department is distinct from v_item.department then
  return jsonb_build_object('ok',false,'status',409,'error','Получатель должен быть действующим шефом того же департамента');
 end if;
 select nickname into v_nickname from public.ws_profiles where login=v_role.login for share;
 if not found or lower(btrim(v_nickname)) is distinct from lower(btrim(v_item.nickname)) then
  return jsonb_build_object('ok',false,'status',409,'error','Ник получателя не совпадает с владельцем заморозки');
 end if;
 -- Use the same member identity and transactional balance/ledger function as existing approvals.
 select count(*) into v_count from public.pd_quest_members where department=v_item.department and track='leader' and lower(btrim(nickname))=lower(btrim(v_nickname));
 if v_count>1 then return jsonb_build_object('ok',false,'status',409,'error','Найдены дубли баланса: требуется сверка'); end if;
 if v_count=0 then
  insert into public.pd_quest_members(department,track,nickname,balance) values(v_item.department,'leader',v_nickname,0) on conflict(department,nickname,track) do nothing;
 end if;
 select id,balance into v_member_id,v_before from public.pd_quest_members where department=v_item.department and track='leader' and lower(btrim(nickname))=lower(btrim(v_nickname)) for update;
 select public.pd_quest_adjust_balance(p_department=>v_item.department,p_track=>'leader',p_nickname=>(select nickname from public.pd_quest_members where id=v_member_id),p_amount=>v_item.amount,p_reviewer=>p_actor,p_reason=>'Разморозка баллов шефа · '||v_item.id::text) into v_result;
 if v_result->>'ok' in ('false','0') then raise exception 'Balance operation rejected'; end if;
 select balance into v_after from public.pd_quest_members where id=v_member_id;
 if v_before is null or v_after is distinct from v_before+v_item.amount then raise exception 'Balance verification failed'; end if;
 update public.pd_quest_leader_frozen set status='thawed',thawed_by=p_actor,thawed_at=now(),target_login=v_role.login,balance_before=v_before,balance_after=v_after where id=p_id returning * into v_item;
 -- Keep the archive's existing "Разморозил" flag in sync where that column exists.
 update public.pd_quest_legacy_history set source_data=case when jsonb_typeof(source_data->'values')='array' and jsonb_array_length(source_data->'values')>7 then jsonb_set(source_data,'{values,7}','true'::jsonb) else source_data end where id::text=v_item.source_history_id;
 return jsonb_build_object('ok',true,'item',to_jsonb(v_item),'balance',v_after);
end $$;
revoke all on function public.pd_quest_import_leader_freeze(text,numeric,text) from public,anon,authenticated;
revoke all on function public.pd_quest_thaw_leader_points(uuid,text,text) from public,anon,authenticated;
grant execute on function public.pd_quest_import_leader_freeze(text,numeric,text) to service_role;
grant execute on function public.pd_quest_thaw_leader_points(uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
