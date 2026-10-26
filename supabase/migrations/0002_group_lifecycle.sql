begin;

alter table public.larp_groups add column updated_at timestamptz not null default now();

create or replace function public.create_group(p_name text)
returns table(id uuid, name text, created_at timestamptz, member_count bigint, role text)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare new_group public.larp_groups%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not exists (select 1 from public.larp_identities i where i.user_id = auth.uid()) then raise exception 'identity required'; end if;
  insert into public.larp_groups(name) values (btrim(p_name)) returning * into new_group;
  insert into public.larp_group_members(group_id, user_id, role) values (new_group.id, auth.uid(), 'owner');
  return query select new_group.id, new_group.name, new_group.created_at, 1::bigint, 'owner'::text;
end;
$$;

create function public.list_group_invites(p_group_id uuid)
returns table(id uuid, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.larp_group_members m
    where m.group_id = p_group_id and m.user_id = auth.uid() and m.role = 'owner'
  ) then raise exception 'owner required'; end if;

  return query
  select i.id, i.created_at, i.expires_at
  from public.larp_group_invites i
  where i.group_id = p_group_id
    and i.consumed_at is null and i.revoked_at is null and i.expires_at > now()
  order by i.created_at, i.id;
end;
$$;

create or replace function public.revoke_group_invite(p_group_id uuid, p_invite_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare target public.larp_group_invites%rowtype;
begin
  perform 1 from public.larp_groups g where g.id = p_group_id for update;
  if not found then raise exception 'group unavailable'; end if;
  if auth.uid() is null or not exists (
    select 1 from public.larp_group_members m
    where m.group_id = p_group_id and m.user_id = auth.uid() and m.role = 'owner'
  ) then raise exception 'owner required'; end if;

  select * into target from public.larp_group_invites i
  where i.id = p_invite_id and i.group_id = p_group_id for update;
  if not found then return; end if;
  if target.consumed_at is null and target.revoked_at is null then
    update public.larp_group_invites i set revoked_at = now() where i.id = target.id;
  end if;
end;
$$;

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
  if not found or invite.consumed_at is not null or invite.revoked_at is not null or invite.expires_at <= now() then
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

create or replace function public.remove_group_member(p_group_id uuid, p_member_user_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare target public.larp_group_members%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform 1 from public.larp_groups g where g.id = p_group_id for update;
  if not found then raise exception 'group unavailable'; end if;
  if not exists (
    select 1 from public.larp_group_members owner_row
    where owner_row.group_id = p_group_id and owner_row.user_id = auth.uid() and owner_row.role = 'owner'
  ) then raise exception 'owner required'; end if;
  if p_member_user_id = auth.uid() then raise exception 'owner cannot remove self'; end if;
  select * into target from public.larp_group_members m
  where m.group_id = p_group_id and m.user_id = p_member_user_id for update;
  if not found or target.role = 'owner' then raise exception 'member cannot be removed'; end if;
  delete from public.larp_group_members m where m.group_id = p_group_id and m.user_id = p_member_user_id;
  update public.larp_groups g set updated_at = now() where g.id = p_group_id;
end;
$$;

create function public.leave_group(p_group_id uuid)
returns table(id uuid, name text, created_at timestamptz, member_count bigint, role text, deleted boolean)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare target_group public.larp_groups%rowtype;
declare mine public.larp_group_members%rowtype;
declare next_owner uuid;
declare remaining_count bigint;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into target_group from public.larp_groups g where g.id = p_group_id for update;
  if not found then raise exception 'group unavailable'; end if;
  select * into mine from public.larp_group_members m
  where m.group_id = p_group_id and m.user_id = auth.uid() for update;
  if not found then raise exception 'group membership required'; end if;

  delete from public.larp_group_members m where m.group_id = p_group_id and m.user_id = auth.uid();
  select count(*) into remaining_count from public.larp_group_members m where m.group_id = p_group_id;
  if mine.role = 'owner' then
    if remaining_count = 0 then
      delete from public.larp_groups g where g.id = p_group_id;
      return query select null::uuid, null::text, null::timestamptz, 0::bigint, null::text, true;
      return;
    end if;
    select m.user_id into next_owner from public.larp_group_members m
    where m.group_id = p_group_id
    order by m.joined_at, m.user_id limit 1;
    update public.larp_group_members m set role = 'member'
    where m.group_id = p_group_id and m.role = 'owner';
    update public.larp_group_members m set role = 'owner'
    where m.group_id = p_group_id and m.user_id = next_owner;
  else
    select m.user_id into next_owner from public.larp_group_members m
    where m.group_id = p_group_id and m.role = 'owner'
    order by m.joined_at, m.user_id limit 1;
  end if;

  update public.larp_groups g set updated_at = now() where g.id = p_group_id;
  return query select target_group.id, target_group.name, target_group.created_at,
    remaining_count, m.role, false
  from public.larp_group_members m where m.group_id = p_group_id and m.user_id = next_owner;
end;
$$;

revoke all on function public.list_group_invites(uuid), public.leave_group(uuid) from public, anon;
revoke all on function public.revoke_group_invite(uuid, uuid), public.accept_group_invite(text), public.remove_group_member(uuid, uuid) from public, anon;
grant execute on function public.list_group_invites(uuid), public.leave_group(uuid),
  public.revoke_group_invite(uuid, uuid), public.accept_group_invite(text), public.remove_group_member(uuid, uuid)
  to authenticated;

commit;
