begin;

select plan(3);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'expiry-owner@larp.invalid', '', now(), now(), now()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa52', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'expiry-invitee@larp.invalid', '', now(), now(), now());

insert into public.larp_groups (id, name)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'Invite expiry test');
insert into public.larp_group_members (group_id, user_id, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51', 'owner');
insert into public.larp_identities (user_id, public_key)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa52', 'expiry-invitee-key');
insert into public.larp_group_invites (id, group_id, token_hash, created_by, expires_at)
values (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc6',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
  repeat('6', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51',
  now() + interval '7 days'
);
insert into public.larp_group_invites (id, group_id, token_hash, created_by, expires_at)
values (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
  repeat('5', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51',
  now() + interval '7 days'
);

-- Privileged fixture setup changes only the invite owned by this test.
update public.larp_group_invites
set expires_at = now() - interval '1 minute'
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5'
  and group_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5';

set local role authenticated;
set local "request.jwt.claim.sub" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51';
set local "request.jwt.claims" = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51","role":"authenticated"}';
select throws_ok(
  $$ select * from public.accept_group_invite(repeat('5', 64)) $$,
  'P0001',
  'invite unavailable',
  'the real invite RPC rejects an expired fixture'
);
set local "request.jwt.claim.sub" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa52';
set local "request.jwt.claims" = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa52","role":"authenticated"}';
select lives_ok(
  $$ select * from public.accept_group_invite(repeat('6', 64)) $$,
  'the real invite RPC accepts an active invite'
);
select ok(
  exists (
    select 1 from public.larp_group_members
    where group_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
      and user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa52'
  ),
  'accepting an active invite adds its user to the group'
);

select * from finish();
rollback;
