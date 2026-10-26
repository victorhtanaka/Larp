begin;

create table public.larp_group_share_leases (
  group_id uuid primary key references public.larp_groups(id) on delete cascade,
  holder_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);

create function private.clear_removed_member_share_lease()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.larp_group_share_leases l
  where l.group_id = old.group_id and l.holder_user_id = old.user_id;
  return old;
end;
$$;

revoke all on function private.clear_removed_member_share_lease() from public, anon, authenticated;
create trigger larp_group_member_clears_share_lease
after delete on public.larp_group_members
for each row execute function private.clear_removed_member_share_lease();

alter table public.larp_group_share_leases enable row level security;
alter table public.larp_group_share_leases force row level security;
revoke all on public.larp_group_share_leases from anon, authenticated;

grant usage on schema public to authenticated;

create function public.acquire_group_share_lease(p_group_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare acquired boolean := false;
declare current_time timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform 1 from public.larp_group_members m
  where m.group_id = p_group_id and m.user_id = auth.uid()
  for key share;
  if not found then raise exception 'group membership required'; end if;

  insert into public.larp_group_share_leases(group_id, holder_user_id, expires_at)
  values (p_group_id, auth.uid(), current_time + interval '45 seconds')
  on conflict (group_id) do update
    set holder_user_id = excluded.holder_user_id,
        expires_at = excluded.expires_at
    where public.larp_group_share_leases.holder_user_id = auth.uid()
       or public.larp_group_share_leases.expires_at <= current_time
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create function public.release_group_share_lease(p_group_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  delete from public.larp_group_share_leases l
  where l.group_id = p_group_id and l.holder_user_id = auth.uid();
end;
$$;

revoke all on function public.acquire_group_share_lease(uuid), public.release_group_share_lease(uuid)
  from public, anon;
grant execute on function public.acquire_group_share_lease(uuid), public.release_group_share_lease(uuid)
  to authenticated;

commit;
