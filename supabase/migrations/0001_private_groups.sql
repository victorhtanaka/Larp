begin;

create schema if not exists private;

create table public.larp_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now(),
  constraint larp_identities_public_key_nonempty check (length(public_key) between 1 and 4096)
);

create table public.larp_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.larp_group_members (
  group_id uuid not null references public.larp_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index larp_group_members_user_idx on public.larp_group_members(user_id, group_id);

create table public.larp_group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.larp_groups(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint larp_invite_seven_days check (expires_at <= created_at + interval '7 days')
);

alter table public.larp_identities enable row level security;
alter table public.larp_identities force row level security;
alter table public.larp_groups enable row level security;
alter table public.larp_groups force row level security;
alter table public.larp_group_members enable row level security;
alter table public.larp_group_members force row level security;
alter table public.larp_group_invites enable row level security;
alter table public.larp_group_invites force row level security;

create function private.is_group_member(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.larp_group_members m
    where m.group_id = p_group_id and m.user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_group_member(uuid) from public, anon;
grant execute on function private.is_group_member(uuid) to authenticated;
grant usage on schema private to authenticated;
create policy identity_self_read on public.larp_identities for select to authenticated using (user_id = (select auth.uid()));
create policy group_member_read on public.larp_groups for select to authenticated using (
  private.is_group_member(id)
);
create policy member_list_read on public.larp_group_members for select to authenticated using (
  private.is_group_member(group_id)
);

revoke all on public.larp_identities, public.larp_groups, public.larp_group_members, public.larp_group_invites from anon, authenticated;
grant select on public.larp_identities, public.larp_groups, public.larp_group_members to authenticated;


create function public.register_identity(p_public_key text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or p_public_key is null or length(p_public_key) not between 1 and 4096 then
    raise exception 'invalid identity';
  end if;
  insert into public.larp_identities(user_id, public_key)
  values (auth.uid(), p_public_key)
  on conflict (user_id) do nothing;
  if not exists (select 1 from public.larp_identities i where i.user_id = auth.uid() and i.public_key = p_public_key) then
    raise exception 'identity already registered';
  end if;
end;
$$;

create function public.create_group(p_name text)
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

create function public.list_my_groups()
returns table(id uuid, name text, created_at timestamptz, member_count bigint, role text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select g.id, g.name, g.created_at,
    (select count(*) from public.larp_group_members all_members where all_members.group_id = g.id),
    mine.role
  from public.larp_groups g join public.larp_group_members mine on mine.group_id = g.id
  where mine.user_id = auth.uid()
  order by g.created_at;
$$;

create function public.create_group_invite(p_group_id uuid, p_token_hash text)
returns table(id uuid, expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare invite_id uuid;
declare expiry timestamptz;
begin
  if auth.uid() is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid invite'; end if;
  if not exists (select 1 from public.larp_group_members m where m.group_id = p_group_id and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'owner required';
  end if;
  insert into public.larp_group_invites(group_id, token_hash, created_by, expires_at)
  values (p_group_id, p_token_hash, auth.uid(), now() + interval '7 days')
  returning larp_group_invites.id, larp_group_invites.expires_at into invite_id, expiry;
  return query select invite_id, expiry;
end;
$$;

create function public.revoke_group_invite(p_group_id uuid, p_invite_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.larp_group_members m where m.group_id = p_group_id and m.user_id = auth.uid() and m.role = 'owner'
  ) then raise exception 'owner required'; end if;
  update public.larp_group_invites i set revoked_at = now()
  where i.id = p_invite_id and i.group_id = p_group_id and i.consumed_at is null and i.revoked_at is null;
  if not found then raise exception 'active invite not found'; end if;
end;
$$;

create function public.accept_group_invite(p_token_hash text)
returns table(id uuid, name text, created_at timestamptz, member_count bigint, role text)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare invite public.larp_group_invites%rowtype;
declare target_group public.larp_groups%rowtype;
declare current_count bigint;
begin
  if auth.uid() is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid invite'; end if;
  select * into invite from public.larp_group_invites i where i.token_hash = p_token_hash for update;
  if not found or invite.consumed_at is not null or invite.revoked_at is not null or invite.expires_at <= now() then
    raise exception 'invite unavailable';
  end if;
  select * into target_group from public.larp_groups g where g.id = invite.group_id for update;
  if not found then raise exception 'group unavailable'; end if;
  if exists (select 1 from public.larp_group_members m where m.group_id = invite.group_id and m.user_id = auth.uid()) then
    raise exception 'already a member';
  end if;
  select count(*) into current_count from public.larp_group_members m where m.group_id = invite.group_id;
  if current_count >= 6 then raise exception 'group is full'; end if;
  if not exists (select 1 from public.larp_identities i where i.user_id = auth.uid()) then raise exception 'identity required'; end if;
  update public.larp_group_invites i set consumed_at = now() where i.id = invite.id;
  insert into public.larp_group_members(group_id, user_id, role) values (invite.group_id, auth.uid(), 'member');
  return query select target_group.id, target_group.name, target_group.created_at, current_count + 1, 'member'::text;
end;
$$;

create function public.remove_group_member(p_group_id uuid, p_member_user_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare target public.larp_group_members%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.larp_group_members owner_row where owner_row.group_id = p_group_id and owner_row.user_id = auth.uid() and owner_row.role = 'owner'
  ) then raise exception 'owner required'; end if;
  select * into target from public.larp_group_members m where m.group_id = p_group_id and m.user_id = p_member_user_id for update;
  if not found or target.role = 'owner' then raise exception 'member cannot be removed'; end if;
  delete from public.larp_group_members m where m.group_id = p_group_id and m.user_id = p_member_user_id;
end;
$$;

create function public.list_group_members(p_group_id uuid)
returns table(user_id uuid, public_key text, joined_at timestamptz, role text)
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not private.is_group_member(p_group_id) then raise exception 'group membership required'; end if;
  return query select m.user_id, i.public_key, m.joined_at, m.role
  from public.larp_group_members m join public.larp_identities i on i.user_id = m.user_id
  where m.group_id = p_group_id order by m.joined_at;
end;
$$;

revoke all on function public.register_identity(text), public.create_group(text), public.list_my_groups(),
  public.create_group_invite(uuid, text), public.revoke_group_invite(uuid, uuid),
  public.accept_group_invite(text), public.remove_group_member(uuid, uuid), public.list_group_members(uuid)
  from public, anon;
grant execute on function public.register_identity(text), public.create_group(text), public.list_my_groups(),
  public.create_group_invite(uuid, text), public.revoke_group_invite(uuid, uuid),
  public.accept_group_invite(text), public.remove_group_member(uuid, uuid), public.list_group_members(uuid)
  to authenticated;

create policy larp_private_channel_read on realtime.messages for select to authenticated using (
  (select private.is_group_member(
    case when realtime.topic() ~ '^group:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then substring(realtime.topic() from 7)::uuid else null end
  ))
);
create policy larp_private_channel_write on realtime.messages for insert to authenticated with check (
  (select private.is_group_member(
    case when realtime.topic() ~ '^group:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then substring(realtime.topic() from 7)::uuid else null end
  ))
);

commit;
