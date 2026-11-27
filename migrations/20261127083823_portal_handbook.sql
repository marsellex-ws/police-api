begin;

create table public.pd_handbook_sections (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
  title text not null check (char_length(title) between 1 and 120),
  sort_order smallint not null unique,
  body_html text not null check (octet_length(body_html) between 1 and 600000),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

alter table public.pd_handbook_sections enable row level security;
revoke all on public.pd_handbook_sections from public, anon, authenticated;
grant select on public.pd_handbook_sections to anon, authenticated;
grant select, insert, update on public.pd_handbook_sections to service_role;

create policy "Anyone can read the published handbook"
on public.pd_handbook_sections for select to anon, authenticated using (true);

commit;
