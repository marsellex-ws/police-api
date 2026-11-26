begin;

-- Mirror only fields already returned by the unauthenticated portal API.
alter table public.pd_portal_leadership enable row level security;
alter table public.pd_range_prizes enable row level security;
alter table public.pd_range_settings enable row level security;
alter table public.pd_punishments enable row level security;

grant select (slot, nickname, avatar_url, vk_url, forum_url, gender)
  on public.pd_portal_leadership to anon, authenticated;
grant select (id, name, tier, hp, armor, image_url, icon, is_enabled, sort_order)
  on public.pd_range_prizes to anon, authenticated;
grant select (id, round_seconds, speed_multiplier, bonus_a, bonus_b, bonus_interval, max_extra_seconds)
  on public.pd_range_settings to anon, authenticated;
grant select (id, department, nickname, account_number, punishment_type, article, reason,
  evidence_url, issued_by, redemption_type, redemption_proof_url, redemption_proof_label,
  status, issued_at, paid_at, paid_by, created_at, updated_at, version)
  on public.pd_punishments to anon, authenticated;

create policy pd_public_leadership_select on public.pd_portal_leadership
  for select to anon, authenticated using (true);
create policy pd_public_enabled_range_prizes_select on public.pd_range_prizes
  for select to anon, authenticated using (is_enabled);
create policy pd_public_range_settings_select on public.pd_range_settings
  for select to anon, authenticated using (id = 1);
create policy pd_public_punishments_select on public.pd_punishments
  for select to anon, authenticated using (true);

-- Enforce server-only writes to site files even if another permissive Storage
-- policy is added later. Other buckets keep their existing permissions.
create policy pd_site_files_server_insert on storage.objects as restrictive
  for insert to anon, authenticated with check (bucket_id <> 'ws-avatars');
create policy pd_site_files_server_update on storage.objects as restrictive
  for update to anon, authenticated
  using (bucket_id <> 'ws-avatars') with check (bucket_id <> 'ws-avatars');
create policy pd_site_files_server_delete on storage.objects as restrictive
  for delete to anon, authenticated using (bucket_id <> 'ws-avatars');

-- PostgREST exposes the invoker wrappers in public. The fixed, read-only
-- projections below access private source columns without granting browser
-- roles access to those columns or exposing this schema through the Data API.
create schema pd_public_read_private;
revoke all on schema pd_public_read_private from public;
grant usage on schema pd_public_read_private to anon, authenticated;

create function pd_public_read_private.chiefs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with calendar as (
    select (pg_catalog.now() at time zone 'Europe/Moscow')::date as today,
           pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'Europe/Moscow')::date as monday
  ), chiefs as (
    select department, nickname, account_number, avatar_url from public.pd_portal_chiefs
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

create function pd_public_read_private.exams(p_slug text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with exams as (
    select slug, title, description, pass_percent, active, created_at
    from public.pd_exams
    where active and slug in ('private', 'captain') and (p_slug is null or slug = p_slug)
  )
  select case when p_slug is null then
    jsonb_build_object('ok', true, 'exams', coalesce((
      select jsonb_agg((to_jsonb(e) - 'created_at') || jsonb_build_object('question_count', (
        select count(*) from public.pd_exam_questions q where q.exam_slug = e.slug
      )) order by e.created_at)
      from exams e
    ), '[]'::jsonb))
  else (
    select jsonb_build_object('ok', true, 'exam', to_jsonb(e) - 'created_at', 'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'exam_slug', q.exam_slug, 'question_order', q.question_order,
        'title', q.title, 'description', q.description, 'answer_mode', q.answer_mode,
        'allow_custom', q.allow_custom, 'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', option -> 'id', 'text', option -> 'text') order by position)
          from jsonb_array_elements(coalesce(q.options, '[]'::jsonb)) with ordinality as opts(option, position)
        ), '[]'::jsonb)
      ) order by q.question_order, q.created_at)
      from (
        select id, exam_slug, question_order, title, description, answer_mode, allow_custom, options, created_at
        from public.pd_exam_questions
        where exam_slug = e.slug
        order by question_order, created_at
        limit 300
      ) q
    ), '[]'::jsonb))
    from exams e
  ) end;
$$;

create function public.pd_public_chiefs()
returns jsonb
language sql stable security invoker set search_path = ''
as $$ select pd_public_read_private.chiefs() $$;

create function public.pd_public_exams(p_slug text default null)
returns jsonb
language sql stable security invoker set search_path = ''
as $$ select pd_public_read_private.exams(p_slug) $$;

revoke execute on function pd_public_read_private.chiefs(), pd_public_read_private.exams(text),
  public.pd_public_chiefs(), public.pd_public_exams(text) from public;
grant execute on function pd_public_read_private.chiefs(), pd_public_read_private.exams(text),
  public.pd_public_chiefs(), public.pd_public_exams(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
