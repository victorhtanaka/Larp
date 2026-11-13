begin;

create index if not exists larp_group_invites_created_by_idx
  on public.larp_group_invites (created_by);
create index if not exists larp_group_invites_group_id_idx
  on public.larp_group_invites (group_id);
create index if not exists larp_group_share_leases_holder_user_id_idx
  on public.larp_group_share_leases (holder_user_id);

create or replace function public.accept_group_invite(p_token_hash text)
returns table(id uuid, name text, created_at timestamptz, member_count bigint, role text)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare invite public.larp_group_invites%rowtype;
declare target_group public.larp_groups%rowtype;
declare current_count bigint;
declare target_group_id uuid;
begin
  if auth.uid() is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid invite'; end if;

  select i.group_id into target_group_id from public.larp_group_invites i where i.token_hash = p_token_hash;
  if not found then raise exception 'invite unavailable'; end if;
  select * into target_group from public.larp_groups g where g.id = target_group_id for update;
  if not found then raise exception 'group unavailable'; end if;
  select * into invite from public.larp_group_invites i
  where i.token_hash = p_token_hash and i.group_id = target_group_id for update;
  if not found or invite.consumed_at is not null or invite.revoked_at is not null
    or invite.expires_at <= clock_timestamp() then
    raise exception 'invite unavailable';
  end if;
  if exists (select 1 from public.larp_group_members m where m.group_id = invite.group_id and m.user_id = auth.uid()) then
    raise exception 'already a member';
  end if;
  select count(*) into current_count from public.larp_group_members m where m.group_id = invite.group_id;
  if current_count >= 6 then raise exception 'group is full'; end if;
  if not exists (select 1 from public.larp_identities i where i.user_id = auth.uid()) then raise exception 'identity required'; end if;
  update public.larp_group_invites i set consumed_at = now() where i.id = invite.id;
  insert into public.larp_group_members(group_id, user_id, role) values (invite.group_id, auth.uid(), 'member');
  update public.larp_groups g set updated_at = now() where g.id = invite.group_id;
  return query select target_group.id, target_group.name, target_group.created_at, current_count + 1, 'member'::text;
end;
$$;

commit;