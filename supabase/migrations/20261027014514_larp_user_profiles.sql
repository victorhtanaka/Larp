begin;

create table public.larp_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_data text,
  constraint larp_user_profiles_display_name_check check (
    display_name is null or (display_name = btrim(display_name) and length(display_name) between 1 and 32)
  ),
  constraint larp_user_profiles_avatar_data_check check (
    avatar_data is null or (
      length(avatar_data) between 27 and 66000
      and avatar_data ~ '^data:image/webp;base64,([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    )
  )
);

alter table public.larp_user_profiles enable row level security;
alter table public.larp_user_profiles force row level security;

create function private.can_view_profile(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select (select auth.uid()) = p_user_id or exists (
    select 1
    from public.larp_group_members viewer
    join public.larp_group_members subject on subject.group_id = viewer.group_id
    where viewer.user_id = (select auth.uid())
      and subject.user_id = p_user_id
  );
$$;
revoke all on function private.can_view_profile(uuid) from public, anon;
grant execute on function private.can_view_profile(uuid) to authenticated;
grant usage on schema private to authenticated;

create policy profile_read_self_or_shared_group
  on public.larp_user_profiles for select to authenticated
  using (private.can_view_profile(user_id));
create policy profile_insert_self
  on public.larp_user_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy profile_update_self
  on public.larp_user_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.larp_user_profiles from anon, authenticated;
grant select on public.larp_user_profiles to authenticated;
grant insert (user_id, display_name, avatar_data) on public.larp_user_profiles to authenticated;
grant update (display_name, avatar_data) on public.larp_user_profiles to authenticated;

alter table public.larp_user_profiles replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'larp_user_profiles'
  ) then
    alter publication supabase_realtime add table public.larp_user_profiles;
  end if;
end;
$$;

commit;
