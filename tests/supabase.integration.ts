import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ScenarioClient { client: SupabaseClient; userId: string }
interface Invite { id: string; code: string }
const groups = new Map<string, { owner: ScenarioClient; members: ScenarioClient[] }>();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `Required environment variable ${name} must be set.`);
  return value;
}

async function configuration(): Promise<{ url: string; key: string }> {
  const url = requireEnv('LARP_TEST_SUPABASE_URL');
  const key = requireEnv('LARP_TEST_SUPABASE_ANON_KEY');
  assert.equal(requireEnv('LARP_TEST_SUPABASE_ISOLATED'), 'true', 'LARP_TEST_SUPABASE_ISOLATED must equal "true".');
  assert.ok(!key.startsWith('sb_secret_'), 'A service-role key cannot be used for integration tests.');
  const keyParts = key.split('.');
  if (keyParts.length === 3) {
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(keyParts[1], 'base64url').toString('utf8')); } catch {}
    assert.ok(!(claims && typeof claims === 'object' && 'role' in claims && claims.role === 'service_role'),
      'A service-role key cannot be used for integration tests.');
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('LARP_TEST_SUPABASE_URL must be a valid URL.'); }
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  assert.ok(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalhost), 'LARP_TEST_SUPABASE_URL must use HTTPS (or HTTP on localhost).');
  assert.ok(!parsed.username && !parsed.password, 'LARP_TEST_SUPABASE_URL must not contain credentials.');
  const distribution = JSON.parse(await readFile(new URL('../default-cloud-config.json', import.meta.url), 'utf8')) as { supabaseUrl?: string };
  assert.notEqual(parsed.origin.toLowerCase(), new URL(distribution.supabaseUrl ?? '').origin.toLowerCase(),
    'Integration URL must differ from the distribution Supabase project.');
  return { url: parsed.toString(), key };
}

async function identity(url: string, key: string): Promise<ScenarioClient> {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInAnonymously();
  assert.ifError(error);
  assert.ok(data.user, 'Anonymous sign-in must return a user.');
  const publicKey = randomBytes(32).toString('base64url');
  const registered = await client.rpc('register_identity', { p_public_key: publicKey });
  assert.ifError(registered.error);
  return { client, userId: data.user.id };
}

async function rpc<T>(person: ScenarioClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await person.client.rpc(name, args);
  assert.ifError(error);
  return data as T;
}
async function invite(owner: ScenarioClient, groupId: string): Promise<Invite> {
  const code = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(code, 'utf8').digest('hex');
  const data = await rpc<{ id: string }>(owner, 'create_group_invite', { p_group_id: groupId, p_token_hash: tokenHash });
  return { id: data.id, code };
}
async function accept(person: ScenarioClient, code: string): Promise<void> {
  const tokenHash = createHash('sha256').update(code, 'utf8').digest('hex');
  await rpc(person, 'accept_group_invite', { p_token_hash: tokenHash });
}
async function createGroup(owner: ScenarioClient, name: string): Promise<string> {
  const group = await rpc<{ id: string }>(owner, 'create_group', { p_name: name });
  groups.set(group.id, { owner, members: [] });
  return group.id;
}
async function expectFailure(action: () => Promise<unknown>, contains: string, message: string): Promise<void> {
  let failure: unknown;
  try { await action(); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, message);
  assert.ok(failure.message.toLowerCase().includes(contains), `${message} (expected error containing "${contains}").`);
}
async function memberRows(person: ScenarioClient, groupId: string): Promise<unknown[]> {
  const { data, error } = await person.client.from('larp_group_members').select('*').eq('group_id', groupId);
  if (error) throw error;
  return data ?? [];
}
async function tableRead(person: ScenarioClient, table: string, groupId: string): Promise<void> {
  const { data, error } = await person.client.from(table).select('*').eq('id', groupId);
  assert.ok(error || (data ?? []).length === 0, `Nonmember must not read rows from ${table}.`);
}

async function scenario(url: string, key: string): Promise<void> {
  const owner = await identity(url, key);
  const member = await identity(url, key);
  const outsider = await identity(url, key);
  const groupId = await createGroup(owner, `integration-${randomBytes(8).toString('hex')}`);
  const invitation = await invite(owner, groupId);
  await accept(member, invitation.code);
  groups.get(groupId)!.members.push(member);

  for (const table of ['larp_groups', 'larp_group_members']) {
    const { data, error } = await member.client.from(table).select('*').eq(table === 'larp_groups' ? 'id' : 'group_id', groupId);
    assert.ifError(error);
    assert.ok((data ?? []).length > 0, `Member must read ${table}.`);
  }
  const listed = await rpc<unknown[]>(member, 'list_group_members', { p_group_id: groupId });
  assert.equal(listed.length, 2, 'Member RPC must list both group members.');
  await tableRead(outsider, 'larp_groups', groupId);
  await tableRead(outsider, 'larp_group_members', groupId);
  await expectFailure(() => rpc(outsider, 'list_group_members', { p_group_id: groupId }), 'membership required', 'Nonmember must be denied member listing.');

  const beforeReplay = await memberRows(owner, groupId);
  await expectFailure(() => accept(outsider, invitation.code), 'invite unavailable', 'Consumed invite replay must fail.');
  assert.equal((await memberRows(owner, groupId)).length, beforeReplay.length, 'Consumed invite replay must not add membership.');

  const revoked = await invite(owner, groupId);
  await rpc(owner, 'revoke_group_invite', { p_group_id: groupId, p_invite_id: revoked.id });
  await expectFailure(() => accept(outsider, revoked.code), 'invite unavailable', 'Revoked invite acceptance must fail.');

  const expiring = await invite(owner, groupId);
  console.log(`\nExpiration fixture (staging project only): invite_id=${expiring.id} group_id=${groupId}`);
  console.log(`UPDATE public.larp_group_invites SET expires_at = now() - interval '1 minute' WHERE id = '${expiring.id}'::uuid AND group_id = '${groupId}'::uuid AND consumed_at IS NULL AND revoked_at IS NULL;`);
  const prompt = createInterface({ input: stdin, output: stdout });
  await prompt.question('After running this SQL in the staging SQL Editor, press Enter to continue. ');
  prompt.close();
  const expiryUser = await identity(url, key);
  await expectFailure(() => accept(expiryUser, expiring.code), 'invite unavailable', 'Expired invite acceptance must fail.');
  assert.equal((await memberRows(owner, groupId)).some(row => (row as { user_id?: string }).user_id === expiryUser.userId), false, 'Expired invite must not add membership.');

  const fullOwner = await identity(url, key);
  const fullId = await createGroup(fullOwner, `capacity-${randomBytes(8).toString('hex')}`);
  const fullPeople = [fullOwner];
  for (let i = 0; i < 4; i++) {
    const person = await identity(url, key); fullPeople.push(person);
    const item = await invite(fullOwner, fullId); await accept(person, item.code);
    groups.get(fullId)!.members.push(person);
  }
  const contenders = [await identity(url, key), await identity(url, key)];
  const pending = await Promise.all(contenders.map(person => invite(fullOwner, fullId)));
  const outcomes = await Promise.all(contenders.map(async (person, index) => {
    try { await accept(person, pending[index].code); groups.get(fullId)!.members.push(person); return 'success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }));
  assert.equal(outcomes.filter(result => result === 'success').length, 1, 'Exactly one concurrent invite acceptance must succeed.');
  assert.equal(outcomes.filter(result => result.toLowerCase().includes('group is full')).length, 1, 'Exactly one concurrent invite acceptance must report group is full.');
  assert.equal((await memberRows(fullOwner, fullId)).length, 6, 'Full group must contain exactly six memberships after concurrent acceptance.');
  const removed = groups.get(fullId)!.members[1];
  await rpc(fullOwner, 'remove_group_member', { p_group_id: fullId, p_member_user_id: removed.userId });
  groups.get(fullId)!.members.splice(1, 1);
  await expectFailure(() => rpc(removed, 'list_group_members', { p_group_id: fullId }), 'membership required', 'Removed member must be denied member listing.');
}

async function main(): Promise<void> {
  const config = await configuration();
  let primary: unknown;
  try { await scenario(config.url, config.key); }
  catch (error) { primary = error; }
  const cleanupErrors: string[] = [];
  for (const [groupId, group] of [...groups.entries()].reverse()) {
    for (const member of [...group.members].reverse()) {
      try { await rpc(member, 'leave_group', { p_group_id: groupId }); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    try { await rpc(group.owner, 'leave_group', { p_group_id: groupId }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (primary) throw primary;
  assert.equal(cleanupErrors.length, 0, `Best-effort integration cleanup failed (${cleanupErrors.length} membership(s)).`);
  console.log('Supabase integration scenario passed.');
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Supabase integration scenario failed.'); process.exitCode = 1; });
