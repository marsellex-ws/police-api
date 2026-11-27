begin;

alter table public.pd_portal_chiefs add column appointed_on date;

-- Preserve the dates already displayed for matching chiefs. A different
-- person listed in the sheet must not provide the current chief's date.
update public.pd_portal_chiefs chiefs set appointed_on=(e.entry->>'appointed_on')::date
from public.pd_chief_term_snapshot snapshot,
     jsonb_array_elements(snapshot.entries) as e(entry)
where chiefs.department=e.entry->>'department'
  and regexp_replace(lower(btrim(chiefs.nickname)),'[[:space:]_]+','_','g')
    =regexp_replace(lower(btrim(e.entry->>'nickname')),'[[:space:]_]+','_','g');

create or replace function pd_public_read_private.chiefs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with calendar as (
    select (pg_catalog.now() at time zone 'Europe/Moscow')::date as today,
           pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'Europe/Moscow')::date as monday
  ), chiefs as (
    select department, nickname, account_number, avatar_url, appointed_on from public.pd_portal_chiefs
  ), activity as (
    select a.department, a.activity_date, a.ao
    from public.pd_chief_ao_daily a
    join chiefs c on c.department = a.department and a.chief_account = coalesce(c.account_number, '')
    cross join calendar
    where a.activity_date between monday - 49 and today
  ), cards as (
    select c.*,
      (select sum(a.ao) from activity a where a.department = c.department and a.activity_date = today) as ao_day,
      (select sum(a.ao) from activity a where a.department = c.department and a.activity_date >= monday) as ao_week
    from chiefs c cross join calendar
  ), weeks as (
    select monday - 49 + 7 * n as starts, monday - 43 + 7 * n as ends
    from calendar cross join pg_catalog.generate_series(0, 7) as series(n)
  ), history as (
    select starts, ends, (
      select jsonb_object_agg(d.department, (
        select sum(a.ao) from activity a
        where a.department = d.department and a.activity_date between starts and ends
      ))
      from (values ('LSPD'), ('SFPD'), ('LVPD')) as d(department)
    ) as totals
    from weeks
  )
  select jsonb_build_object(
    'ok', true,
    'items', coalesce((select jsonb_agg(to_jsonb(c) order by c.department) from cards c), '[]'::jsonb),
    'activity', jsonb_build_object('today', today, 'week_start', monday, 'weeks', (
      select jsonb_agg(jsonb_build_object('start', starts, 'end', ends, 'totals', totals) order by starts)
      from history
    ))
  )
  from calendar;
$$;

create function public.pd_save_leadership_chief(
  p_slot text,p_nickname text,p_avatar_url text,p_vk_url text,p_forum_url text,p_gender text,
  p_account_number text,p_appointed_on date,p_actor text
) returns jsonb
language plpgsql security invoker set search_path=''
as $$
declare
  v_department text;
  v_leader public.pd_portal_leadership%rowtype;
  v_chief public.pd_portal_chiefs%rowtype;
begin
  v_department := case p_slot when 'leader_lspd' then 'LSPD' when 'leader_sfpd' then 'SFPD' when 'leader_lvpd' then 'LVPD' end;
  if v_department is null then raise sqlstate '22023' using message='Unknown chief slot'; end if;

  update public.pd_portal_leadership set
    nickname=p_nickname, avatar_url=p_avatar_url, vk_url=p_vk_url,
    forum_url=p_forum_url, gender=p_gender, updated_by=p_actor, updated_at=now()
  where slot=p_slot returning * into strict v_leader;

  update public.pd_portal_chiefs set
    nickname=p_nickname, avatar_url=p_avatar_url, account_number=p_account_number,
    appointed_on=p_appointed_on, updated_by=p_actor, updated_at=now()
  where department=v_department returning * into strict v_chief;

  insert into public.pd_portal_admin_events(actor,target,action) values(p_actor,p_slot,'set_leadership');

  return jsonb_build_object('ok',true,'item',jsonb_build_object(
    'slot',v_leader.slot,'nickname',v_leader.nickname,'avatar_url',v_leader.avatar_url,
    'vk_url',v_leader.vk_url,'forum_url',v_leader.forum_url,'gender',v_leader.gender
  ),'chief',jsonb_build_object(
    'department',v_chief.department,'nickname',v_chief.nickname,'avatar_url',v_chief.avatar_url,
    'account_number',v_chief.account_number,'appointed_on',v_chief.appointed_on
  ));
end;
$$;
revoke all on function public.pd_save_leadership_chief(text,text,text,text,text,text,text,date,text) from public,anon,authenticated;
grant execute on function public.pd_save_leadership_chief(text,text,text,text,text,text,text,date,text) to service_role;

notify pgrst, 'reload schema';
commit;
