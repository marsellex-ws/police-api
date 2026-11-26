begin;

create schema pd_admin_read_private;
revoke all on schema pd_admin_read_private from public;
grant usage on schema pd_admin_read_private to anon, authenticated;

create function pd_admin_read_private.read(p_session_token text, p_resource text, p_search text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_login text;
  v_nick text;
  v_role text;
  v_department text;
  v_avatar text;
  v_root constant text := 'https://pbwgvyhchpzmgqjyqxzv.supabase.co/storage/v1/object/public/ws-avatars/';
  v_manager boolean;
  v_admin boolean;
  v_leader boolean;
  v_rows jsonb;
  v_search text;
begin
  -- Checking the World Script token here is read-only. The existing WS
  -- access-state function extends the session and is used by the write API.
  if coalesce(p_session_token, '') !~* '^[a-f0-9]{64}$' then
    raise sqlstate 'PT401' using message = 'Требуется авторизация';
  end if;

  select lower(btrim(s.login)) into v_login
  from public.ws_sessions s
  where s.token_hash = encode(extensions.digest(lower(p_session_token), 'sha256'), 'hex')
    and s.expires_at > now()
    and s.created_at > now() - interval '24 hours'
    and s.created_at <= now() + interval '1 minute'
  limit 1;

  if coalesce(v_login, '') = '' then
    raise sqlstate 'PT401' using message = 'Сессия истекла';
  end if;

  select role, department into v_role, v_department from public.pd_ws_roles where login = v_login;
  select coalesce(nickname, v_login),
    case
      when btrim(avatar_path) ~ '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$'
        and strpos(avatar_path, '..') = 0 then v_root || btrim(avatar_path)
      when starts_with(avatar_url, v_root) and avatar_url !~ '[<> \\]' then avatar_url
      else null
    end
  into v_nick, v_avatar
  from public.ws_profiles where lower(login) = v_login limit 1;
  v_nick := coalesce(v_nick, v_login);

  v_admin := coalesce(v_role in ('developer','admin'), false);
  v_manager := v_admin or v_role is not distinct from 'minister';
  v_leader := coalesce(v_role = 'leader' and v_department in ('LSPD','SFPD','LVPD'), false);

  if p_resource = 'me' then
    return jsonb_build_object('ok',true,'user',jsonb_build_object(
      'id',v_login,'login',v_login,'nickname',v_nick,'role',v_role,'role_department',v_department,
      'department',coalesce(v_department,''),'avatar_url',v_avatar,'is_admin',v_admin,
      'editable_departments', case when v_manager then array['LSPD','SFPD','LVPD']
        when v_role in ('leader','senior') and v_department in ('LSPD','SFPD','LVPD') then array[v_department] else array[]::text[] end
    ));
  end if;

  if not (case
    when p_resource in ('users','range') then v_admin
    when p_resource in ('role-users','role-requests','quest-history') then v_manager
    when p_resource in ('quest-bootstrap','quest-roster','quest-requests') then v_manager or v_leader
    else false
  end) then
    raise sqlstate 'PT403' using message = 'Недостаточно прав';
  end if;

  if p_resource = 'users' then
    select jsonb_agg(to_jsonb(x) order by x.nickname) into v_rows from (
      select p.login,p.nickname,p.department,p.avatar_url,p.avatar_path,r.role,coalesce(l.vk_url,'') as vk_url
      from public.ws_profiles p
      left join public.pd_ws_roles r on r.login = lower(p.login)
      left join public.pd_portal_user_links l on l.login = lower(p.login)
      where p.login <> ''
      order by p.nickname limit 500
    ) x;
  elsif p_resource = 'range' then
    return jsonb_build_object('ok',true,'prizes',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order) from (
        select id,name,tier,hp,armor,image_url,icon,is_enabled,sort_order
        from public.pd_range_prizes order by sort_order limit 200
      ) x
    ),'[]'::jsonb),'settings',(
      select to_jsonb(x) from (
        select id,round_seconds,speed_multiplier,bonus_a,bonus_b,bonus_interval,max_extra_seconds
        from public.pd_range_settings where id=1
      ) x
    ));
  elsif p_resource = 'role-users' then
    v_search := lower(btrim(coalesce(p_search,'')));
    if v_search ~ '^[a-z0-9_.-]{2,32}$' then
      select jsonb_agg(to_jsonb(x) order by x.login) into v_rows from (
        select lower(p.login) as id,lower(p.login) as login,p.nickname,p.avatar_url,p.avatar_path,r.role,r.department
        from public.ws_profiles p left join public.pd_ws_roles r on r.login = lower(p.login)
        where starts_with(lower(p.login),v_search) order by p.login limit 20
      ) x;
    end if;
  elsif p_resource = 'role-requests' then
    select jsonb_agg(to_jsonb(x) order by x.created_at desc) into v_rows from (
      select r.id,r.requested_by,r.target_login,r.target_login as target_id,r.department,r.status,r.created_at,
        coalesce(a.nickname,r.requested_by) as requested_by_user,coalesce(b.nickname,r.target_login) as target_user
      from public.pd_ws_role_requests r
      left join public.ws_profiles a on a.login=r.requested_by
      left join public.ws_profiles b on b.login=r.target_login
      where r.status='pending' order by r.created_at desc limit 100
    ) x;
  elsif p_resource = 'quest-bootstrap' then
    return jsonb_build_object('ok',true,'me',jsonb_build_object(
      'nickname',v_nick,'login',v_login,'role',v_role,
      'department',case when v_department in ('LSPD','SFPD','LVPD') then v_department else null end,
      'permissions',case when v_manager then 'all' else 'leader' end,
      'track',case when v_leader then 'leader' else 'senior' end
    ),'jobs',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order) from (
        select id,title,audience,points_min,points_max,calc_type,requirements,daily_limit,weekly_limit,active,sort_order
        from public.pd_quest_catalog where active
      ) x
    ),'[]'::jsonb),'rewards',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order) from (
        select id,title,audience,cost,conditions,requires_approval,active,sort_order from public.pd_quest_rewards where active
      ) x
    ),'[]'::jsonb));
  elsif p_resource = 'quest-roster' then
    select jsonb_agg(to_jsonb(x) order by x.department,x.track,x.nickname) into v_rows from (
      select id,department,nickname,account_number,track,balance,warnings,proof,note,updated_at
      from public.pd_quest_members
      where v_manager or (department=v_department and track='senior')
      order by department,track,nickname limit 300
    ) x;
  elsif p_resource = 'quest-requests' then
    select jsonb_agg(to_jsonb(x) order by x.created_at desc) into v_rows from (
      select id,kind,department,track,nickname,requested_by,item_id,item_title,quantity,points,evidence_url,note,status,reviewed_by,review_note,created_at,reviewed_at
      from public.pd_quest_requests
      where v_manager or (department=v_department and (track='senior' or requested_by=v_login))
      order by created_at desc limit 120
    ) x;
  elsif p_resource = 'quest-history' then
    select jsonb_agg(to_jsonb(x) order by x.id desc) into v_rows from (
      select id,source_sheet,source_row,track,department,nickname,event_type,before_points,amount,after_points,description,event_date,date_text,needs_review,source_data
      from public.pd_quest_legacy_history order by id desc limit 1000
    ) x;
  end if;
  return jsonb_build_object('ok',true,'items',coalesce(v_rows,'[]'::jsonb));
end;
$$;

-- The Data API wrapper accepts POST only, keeping the session token out of URLs.
create function public.pd_admin_read(p_session_token text, p_resource text, p_search text default null)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$ select pd_admin_read_private.read(p_session_token,p_resource,p_search) $$;
revoke execute on function public.pd_admin_read(text,text,text), pd_admin_read_private.read(text,text,text) from public;
grant execute on function public.pd_admin_read(text,text,text), pd_admin_read_private.read(text,text,text) to anon, authenticated;

create table public.pd_leadership_order (
  id smallint primary key check (id = 1),
  slots text[] not null,
  version integer not null default 1
);
insert into public.pd_leadership_order (id,slots) values (1,array[
  'responsible','curator_lspd','curator_sfpd','curator_lvpd','minister',
  'leader_lspd','leader_sfpd','leader_lvpd','swat_commander','swat_deputy','swat_deputy_2'
]);
alter table public.pd_leadership_order enable row level security;
revoke all on public.pd_leadership_order from public, anon, authenticated;
grant select on public.pd_leadership_order to anon, authenticated;
grant select,update on public.pd_leadership_order to service_role;
create policy pd_public_leadership_order_read on public.pd_leadership_order
  for select to anon, authenticated using (id = 1);

create function public.pd_move_leadership_slot(p_slot text,p_neighbor text,p_version integer,p_actor text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_layout public.pd_leadership_order%rowtype;
  v_curators text[] := array['responsible','curator_lspd','curator_sfpd','curator_lvpd'];
  v_leaders text[] := array['leader_lspd','leader_sfpd','leader_lvpd'];
  v_swat text[] := array['swat_commander','swat_deputy','swat_deputy_2'];
  v_line text[];
  v_slots text[];
  v_a integer;
  v_b integer;
begin
  select * into strict v_layout from public.pd_leadership_order where id=1 for update;
  if v_layout.version is distinct from p_version then
    return jsonb_build_object('ok',false,'conflict',true,'slots',v_layout.slots,'version',v_layout.version);
  end if;

  if (select count(*) from public.pd_portal_leadership where slot=any(v_curators)
      and btrim(nickname)<>'' and btrim(vk_url)<>'' and btrim(forum_url)<>'')=4 then
    v_leaders := array_prepend('minister',v_leaders);
  else
    v_curators := array_append(v_curators,'minister');
  end if;

  v_line := case when p_slot=any(v_curators) then v_curators
    when p_slot=any(v_leaders) then v_leaders when p_slot=any(v_swat) then v_swat end;
  if v_line is null or p_neighbor is null or not p_neighbor=any(v_line) then
    return jsonb_build_object('ok',false);
  end if;

  select array_agg(slot order by pos) into v_slots
  from unnest(v_layout.slots) with ordinality as ordered(slot,pos) where slot=any(v_line);
  if abs(array_position(v_slots,p_slot)-array_position(v_slots,p_neighbor)) is distinct from 1 then
    return jsonb_build_object('ok',false);
  end if;

  v_a := array_position(v_layout.slots,p_slot);
  v_b := array_position(v_layout.slots,p_neighbor);
  v_layout.slots[v_a] := p_neighbor;
  v_layout.slots[v_b] := p_slot;
  update public.pd_leadership_order set slots=v_layout.slots,version=version+1
    where id=1 returning * into v_layout;
  insert into public.pd_portal_admin_events(actor,target,action)
    values(p_actor,p_slot,'set_leadership');
  return jsonb_build_object('ok',true,'slots',v_layout.slots,'version',v_layout.version);
end;
$$;
revoke execute on function public.pd_move_leadership_slot(text,text,integer,text) from public, anon, authenticated;
grant execute on function public.pd_move_leadership_slot(text,text,integer,text) to service_role;

notify pgrst, 'reload schema';
commit;
