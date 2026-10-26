begin;

create or replace function public.acquire_group_share_lease(p_group_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare acquired boolean := false;
declare lease_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform 1 from public.larp_group_members m
  where m.group_id = p_group_id and m.user_id = auth.uid()
  for key share;
  if not found then raise exception 'group membership required'; end if;

  insert into public.larp_group_share_leases(group_id, holder_user_id, expires_at)
  values (p_group_id, auth.uid(), lease_now + interval '45 seconds')
  on conflict (group_id) do update
    set holder_user_id = excluded.holder_user_id,
        expires_at = excluded.expires_at
    where public.larp_group_share_leases.holder_user_id = auth.uid()
       or public.larp_group_share_leases.expires_at <= lease_now
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

commit;