begin;

select plan(14);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-owner@larp.invalid', '', now(), now(), now()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-member@larp.invalid', '', now(), now(), now()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-outsider@larp.invalid', '', now(), now(), now());

insert into public.larp_groups (id, name)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Profile policy test');
insert into public.larp_group_members (group_id, user_id, role)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'owner'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'member');
insert into public.larp_user_profiles (user_id, display_name, avatar_data)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Profile owner', null),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Profile member', null),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Profile outsider', null);

select ok((select relrowsecurity from pg_class where oid = 'public.larp_user_profiles'::regclass), 'RLS is enabled');
select ok((select relforcerowsecurity from pg_class where oid = 'public.larp_user_profiles'::regclass), 'RLS is forced');
select ok(not has_table_privilege('anon', 'public.larp_user_profiles', 'SELECT'), 'anon cannot select profiles');
select ok(not has_table_privilege('anon', 'public.larp_user_profiles', 'INSERT'), 'anon cannot insert profiles');
select ok(has_table_privilege('authenticated', 'public.larp_user_profiles', 'SELECT'), 'authenticated can select profiles');
select ok(has_column_privilege('authenticated', 'public.larp_user_profiles', 'user_id', 'INSERT'), 'authenticated can insert their own profile key');
select ok(has_column_privilege('authenticated', 'public.larp_user_profiles', 'display_name', 'UPDATE'), 'authenticated can update profile fields');
select ok(not has_column_privilege('authenticated', 'public.larp_user_profiles', 'user_id', 'UPDATE'), 'authenticated cannot change a profile owner');

set local role authenticated;
set local "request.jwt.claim.sub" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
set local "request.jwt.claims" = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1","role":"authenticated"}';
select is((select display_name from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'Profile owner', 'a user can read their own profile');
select is((select display_name from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'), 'Profile member', 'group members can read profiles in common private groups');

set local "request.jwt.claim.sub" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
set local "request.jwt.claims" = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2","role":"authenticated"}';
select is((select display_name from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'Profile owner', 'the other group member can read the owner profile');
select is((select count(*)::integer from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'), 0, 'a nonmember cannot read an outsider profile');
update public.larp_user_profiles set display_name = 'Unauthorized'
where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
select is((select display_name from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'Profile owner', 'a member cannot update another user profile');
update public.larp_user_profiles set display_name = 'Member updated'
where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
select is((select display_name from public.larp_user_profiles where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'), 'Member updated', 'a user can update their own profile');

select * from finish();
rollback;
