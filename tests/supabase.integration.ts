import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createNativeCore, NativeCoreError, type NativeCoreClient } from '../src/main/native-core';
import type { CoreOperation, CorePayloadByOperation, CoreRequest, JsonResponse } from '../src/shared/native-core-contracts';

interface NativePerson { core: NativeCoreClient; userId: string; userDataPath: string }
const groups = new Map<string, { owner: NativePerson; members: NativePerson[] }>();
const people: NativePerson[] = [];

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
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  assert.ok(isLoopback, 'LARP_TEST_SUPABASE_URL must target loopback only.');
  assert.equal(parsed.protocol, 'http:', 'Loopback integration URL must use HTTP.');
  assert.ok(!parsed.username && !parsed.password, 'LARP_TEST_SUPABASE_URL must not contain credentials.');
  const distribution = JSON.parse(await readFile(new URL('../default-cloud-config.json', import.meta.url), 'utf8')) as { supabaseUrl?: string };
  assert.notEqual(parsed.origin.toLowerCase(), new URL(distribution.supabaseUrl ?? '').origin.toLowerCase(),
    'Integration URL must differ from the distribution Supabase project.');
  return { url: parsed.toString(), key };
}

function isolatedSecrets(requestJson: string): Promise<string> {
  const call = JSON.parse(requestJson) as { version: number; kind: string; op: string; payload: Record<string, unknown> };
  let response: JsonResponse;
  if (call.version === 1 && call.kind === 'secrets' && call.op === 'available') {
    response = { version: 1, ok: true, value: true };
  } else if (call.version === 1 && call.kind === 'secrets' && call.op === 'encrypt') {
    response = { version: 1, ok: true, value: { ciphertextBase64: call.payload.plaintextBase64 as string } };
  } else if (call.version === 1 && call.kind === 'secrets' && call.op === 'decrypt') {
    response = { version: 1, ok: true, value: { plaintextBase64: call.payload.ciphertextBase64 as string, shouldReEncrypt: false } };
  } else if (call.version === 1 && call.kind === 'cloud' && (call.op === 'set-auth' || call.op === 'dispose')) {
    response = { version: 1, ok: true, value: { data: null, error: null } };
  } else {
    response = { version: 1, ok: false, error: { code: 'TEST_HOST_OPERATION', message: 'Unexpected isolated host operation.' } };
  }
  return Promise.resolve(JSON.stringify(response));
}

const addonPath = join(process.cwd(), 'native/larp-core/dist/larp_core.win32-x64-msvc.node');
async function nativePerson(url: string, key: string): Promise<NativePerson> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-supabase-native-'));
  let core: NativeCoreClient | undefined;
  try {
    const preservedKey = 'sb-preserved-auth-token';
    const preservedValue = 'legacy-session-map-entry';
    await writeFile(join(userDataPath, 'supabase-session.json'), JSON.stringify({ version: 1, values: { [preservedKey]: preservedValue } }), { flag: 'wx' });
    core = await createNativeCore(userDataPath, { url, anonKey: key }, isolatedSecrets, () => {}, addonPath);
    await core.request({ version: 1, op: 'refreshCloud', payload: {} });
    const status = await core.request({ version: 1, op: 'getCloudStatus', payload: {} }) as { userId: string };
    assert.match(status.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'Native cloud refresh must establish an authenticated user.');
    await core.close();
    core = await createNativeCore(userDataPath, { url, anonKey: key }, isolatedSecrets, () => {}, addonPath);
    await core.request({ version: 1, op: 'refreshCloud', payload: {} });
    const restored = await core.request({ version: 1, op: 'getCloudStatus', payload: {} }) as { userId: string };
    assert.equal(restored.userId, status.userId, 'Reopening the temp profile must restore the same Auth session.');
    const saved = JSON.parse(await readFile(join(userDataPath, 'supabase-session.json'), 'utf8')) as {
      version: number; values: Record<string, string>;
    };
    assert.equal(saved.values[preservedKey], preservedValue, 'Session persistence must retain unrelated legacy map entries.');
    const authKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
    const session = JSON.parse(saved.values[authKey]) as { access_token?: unknown; refresh_token?: unknown; user?: { id?: string } };
    assert.equal(session.user?.id, status.userId);
    assert.equal(typeof session.access_token, 'string');
    assert.equal(typeof session.refresh_token, 'string');
    const person = { core, userId: restored.userId, userDataPath };
    people.push(person);
    return person;
  } catch (error) {
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
    throw error;
  }
}
async function invalidRefreshFailsClosed(url: string, key: string): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-supabase-invalid-refresh-'));
  let core: NativeCoreClient | undefined;
  try {
    const authKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
    const session = {
      access_token: 'expired-access-token',
      refresh_token: 'invalid-refresh-token',
      expires_at: 1,
      user: { id: '11111111-1111-4111-8111-111111111111' },
    };
    await writeFile(join(userDataPath, 'supabase-session.json'), JSON.stringify({
      version: 1,
      values: { [authKey]: JSON.stringify(session) },
    }), { flag: 'wx' });
    core = await createNativeCore(userDataPath, { url, anonKey: key }, isolatedSecrets, () => {}, addonPath);
    await assert.rejects(core.request({ version: 1, op: 'refreshCloud', payload: {} }),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'cloud-authentication',
      'A failed refresh must not silently create a replacement anonymous session.');
    const status = await core.request({ version: 1, op: 'getCloudStatus', payload: {} }) as { state: string };
    assert.equal(status.state, 'unavailable');
  } finally {
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
}

function request<O extends CoreOperation>(person: NativePerson, op: O, payload: CorePayloadByOperation[O]): Promise<unknown> {
  return person.core.request({ version: 1, op, payload } as CoreRequest);
}
async function createGroup(owner: NativePerson, name: string): Promise<string> {
  const result = await request(owner, 'createCloudGroup', { name }) as { id: string };
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Native createCloudGroup must return a valid UUID id.');
  groups.set(result.id, { owner, members: [] });
  return result.id;
}
async function invite(owner: NativePerson, groupId: string): Promise<{ id: string; code: string }> {
  const result = await request(owner, 'createCloudInvite', { groupId }) as { id: string; code: string };
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Native createCloudInvite must return a valid UUID id.');
  assert.match(result.code, /^[A-Za-z0-9_-]{43}$/u, 'Native invite code must be URL-safe.');
  return result;
}
async function accept(person: NativePerson, code: string): Promise<void> {
  await request(person, 'acceptCloudInvite', { code });
}
async function expectFailure(action: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof NativeCoreError && error.code === 'cloud-response-invalid', message);
}
async function rawRlsAssertions(url: string, key: string, groupId: string): Promise<void> {
  const outsider = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await outsider.auth.signInAnonymously();
  assert.ifError(error);
  assert.ok(data.user, 'Isolated raw-RLS client must sign in anonymously.');
  for (const table of ['larp_groups', 'larp_group_members'] as const) {
    const filter = table === 'larp_groups' ? 'id' : 'group_id';
    const result = await outsider.from(table).select('*').eq(filter, groupId);
    assert.ifError(result.error);
    assert.deepEqual(result.data, [], `Nonmember must receive an empty result from ${table}.`);
  }
  const profile = await outsider.from('larp_user_profiles').select('user_id').eq('user_id', groups.get(groupId)!.owner.userId).maybeSingle();
  assert.ifError(profile.error);
  assert.equal(profile.data, null, 'A nonmember must not read another user profile.');
  const unauthorizedUpdate = await outsider.from('larp_user_profiles')
    .update({ display_name: 'Tentativa externa' })
    .eq('user_id', groups.get(groupId)!.owner.userId)
    .select('user_id');
  assert.ifError(unauthorizedUpdate.error);
  assert.deepEqual(unauthorizedUpdate.data, [], 'A nonmember must not modify another user profile.');
}

async function scenario(url: string, key: string): Promise<void> {
  const owner = await nativePerson(url, key);
  const member = await nativePerson(url, key);
  const outsider = await nativePerson(url, key);
  const groupId = await createGroup(owner, `integration-${randomBytes(8).toString('hex')}`);
  const invitation = await invite(owner, groupId);
  await accept(member, invitation.code);
  groups.get(groupId)!.members.push(member);

  const nativeMembers = await request(member, 'getCloudMembers', { groupId }) as unknown[];
  assert.equal(nativeMembers.length, 2, 'Native member listing must return both group members.');
  const ownerLease = await request(owner, 'acquireScreenShare', { groupId });
  assert.equal(ownerLease, true, 'Group owner must acquire the screen-share lease.');
  try {
    assert.equal(await request(member, 'acquireScreenShare', { groupId }), false,
      'A second member must not acquire an active screen-share lease.');
  } finally {
    await request(owner, 'releaseScreenShare', { groupId });
  }
  assert.equal(await request(member, 'acquireScreenShare', { groupId }), true,
    'A member must acquire the released screen-share lease.');
  await request(member, 'releaseScreenShare', { groupId });

  await expectFailure(() => request(outsider, 'getCloudMembers', { groupId }), 'Nonmember must be denied member listing.');

  const ownerProfile = await request(owner, 'saveMyProfile', { displayName: 'Dono do grupo', avatarData: null }) as { userId: string };
  assert.equal(ownerProfile.userId, owner.userId, 'Native profile insertion must bind user_id to the authenticated session.');
  const memberProfile = await request(member, 'saveMyProfile', { displayName: 'Membro do grupo', avatarData: null }) as { userId: string };
  assert.equal(memberProfile.userId, member.userId, 'Native profile insertion must bind user_id to the authenticated session.');
  await rawRlsAssertions(url, key, groupId);
  const forgedProfile = owner.core.request({
    version: 1,
    op: 'saveMyProfile',
    payload: { displayName: 'Forjado', avatarData: null, userId: outsider.userId },
  } as CoreRequest);
  await assert.rejects(forgedProfile, (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-request',
    'A caller-supplied profile userId must be rejected.');
  await request(owner, 'saveMyProfile', { displayName: 'Dono atualizado', avatarData: null });
  const updatedOwnerProfile = await request(owner, 'getMyProfile', {}) as { userId: string; displayName: string };
  assert.deepEqual(updatedOwnerProfile, { userId: owner.userId, displayName: 'Dono atualizado', avatarData: null },
    'Profile updates must keep the authenticated user id and editable fields.');
  assert.equal((await request(member, 'getMyProfile', {}) as { displayName: string }).displayName, 'Membro do grupo');
  const replayInvite = await invite(owner, groupId);
  await accept(outsider, replayInvite.code);
  groups.get(groupId)!.members.push(outsider);
  const replayPerson = await nativePerson(url, key);
  await expectFailure(() => accept(replayPerson, replayInvite.code), 'Consumed invite replay must fail.');
  const fullOwner = await nativePerson(url, key);
  const fullId = await createGroup(fullOwner, `capacity-${randomBytes(8).toString('hex')}`);
  for (let i = 0; i < 4; i++) {
    const person = await nativePerson(url, key);
    const item = await invite(fullOwner, fullId);
    await accept(person, item.code);
    groups.get(fullId)!.members.push(person);
  }
  const contenders = [await nativePerson(url, key), await nativePerson(url, key)];
  const pending = await Promise.all(contenders.map(() => invite(fullOwner, fullId)));
  const outcomes = await Promise.all(contenders.map(async (person, index) => {
    try {
      await accept(person, pending[index].code);
      groups.get(fullId)!.members.push(person);
      return true;
    } catch (error) {
      assert.ok(error instanceof NativeCoreError, 'Rejected concurrent acceptance must be a native cloud error.');
      assert.equal(error.code, 'cloud-response-invalid', 'Only the server capacity constraint may reject the race.');
      return false;
    }
  }));
  assert.equal(outcomes.filter(Boolean).length, 1, 'Exactly one concurrent native invite acceptance must succeed at capacity.');
  assert.equal((await request(fullOwner, 'getCloudMembers', { groupId: fullId }) as unknown[]).length, 6,
    'Concurrent acceptance must leave exactly six memberships.');
}

async function main(): Promise<void> {
  const config = await configuration();
  let primary: unknown;
  try {
    await invalidRefreshFailsClosed(config.url, config.key);
    await scenario(config.url, config.key);
  } catch (error) { primary = error; }
  const cleanupErrors: string[] = [];
  for (const [groupId, group] of [...groups.entries()].reverse()) {
    for (const member of [...group.members].reverse()) {
      try { await request(member, 'leaveCloudGroup', { groupId }); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    try { await request(group.owner, 'leaveCloudGroup', { groupId }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const person of [...people].reverse()) {
    try { await person.core.close(); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    await rm(person.userDataPath, { recursive: true, force: true });
  }
  if (primary) throw primary;
  assert.equal(cleanupErrors.length, 0, `Best-effort integration cleanup failed (${cleanupErrors.length} operation(s)).`);
  console.log('Supabase integration scenario passed.');
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Supabase integration scenario failed.'); process.exitCode = 1; });
