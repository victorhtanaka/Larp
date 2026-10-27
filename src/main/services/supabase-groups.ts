import { safeStorage } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isRecord, validateProtocolEnvelope, type SignedProtocolEnvelope } from '../../shared/webrtc-protocol';
import type { CloudConfigurationStatus, GroupInvite, GroupInviteSummary, GroupLeaveResult, GroupMember, GroupSummary, UserProfile, UserProfileUpdate } from '../../shared/cloud-contracts';
import type { TurnCredentialServer } from '../../shared/contracts';
import { normalizeProfileFields, userProfileFrom } from '../profile-validation';

interface LocalCloudConfig { supabaseUrl?: string; supabaseAnonKey?: string }
interface GroupRow { id: string; name: string; created_at: string; member_count: number; role: 'owner' | 'member' }
interface InviteRow { id: string; expires_at: string }
interface InviteSummaryRow { id: string; created_at: string; expires_at: string }

type SignalListener = (senderId: string, envelope: SignedProtocolEnvelope) => void;
type MembershipListener = (members: GroupMember[]) => void;
type MembershipErrorListener = (message: string) => void;
type SignalChannel = ReturnType<SupabaseClient['channel']>;
interface SignalChannelState {
  channel: SignalChannel;
  opening: Promise<void>;
  listeners: Set<SignalListener>;
  membershipListeners: Set<MembershipListener>;
  membershipErrorListeners: Set<MembershipErrorListener>;
  memberIds: Set<string>;
  activeSends: number;
}

function isTargetedSignal(envelope: SignedProtocolEnvelope): envelope is Extract<SignedProtocolEnvelope,
  { kind: 'description' | 'ice-batch' | 'connect-request' | 'protocol-error' }> {
  return envelope.kind === 'description'
    || envelope.kind === 'ice-batch'
    || envelope.kind === 'connect-request'
    || envelope.kind === 'protocol-error';
}

const REALTIME_SIGNAL_EVENT = 'signal';
const REALTIME_SUBSCRIBE_TIMEOUT_MS = 15_000;

interface EncryptedAuthState { version: 1; values: Record<string, string> }

function createEncryptedAuthStorage(storagePath: string) {
  let queue: Promise<void> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const readState = async (): Promise<EncryptedAuthState> => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure cloud-session storage is unavailable.');
    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(storagePath);
    } catch (error) {
      const missingFile = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (missingFile) return { version: 1, values: {} };
      throw new Error('Encrypted cloud-session storage could not be read.', { cause: error });
    }
    try {
      const parsed: unknown = JSON.parse(safeStorage.decryptString(ciphertext));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !('version' in parsed) || !('values' in parsed) || parsed.version !== 1
        || !parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
        throw new Error('Invalid session format.');
      }
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.values)) {
        if (typeof value !== 'string') throw new Error('Invalid session value.');
        values[key] = value;
      }
      return { version: 1, values };
    } catch (error) {
      throw new Error('Encrypted cloud-session data cannot be decrypted safely.', { cause: error });
    }
  };
  const writeState = async (state: EncryptedAuthState): Promise<void> => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure cloud-session storage is unavailable.');
    await mkdir(dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600, flag: 'w' });
      await rename(temporaryPath, storagePath);
    } catch (error) {
      throw new Error('Encrypted cloud-session data could not be persisted.', { cause: error });
    }
  };
  return {
    getItem: (key: string) => serialize(async () => (await readState()).values[key] ?? null),
    setItem: (key: string, value: string) => serialize(async () => {
      const state = await readState();
      state.values[key] = value;
      await writeState(state);
    }),
    removeItem: (key: string) => serialize(async () => {
      const state = await readState();
      delete state.values[key];
      await writeState(state);
    }),
  };
}
function rejectAdministrativeKey(key: string): void {
  if (key.startsWith('sb_secret_')) throw new Error('Supabase service-role credentials are not allowed in the desktop client.');
  const segments = key.split('.');
  if (segments.length !== 3) return;
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (claims && typeof claims === 'object' && !Array.isArray(claims)
      && 'role' in claims && claims.role === 'service_role') {
      throw new Error('Supabase service-role credentials are not allowed in the desktop client.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Supabase service-role')) throw error;
  }
}

function one(data: unknown, operation: string): unknown {
  if (!Array.isArray(data) || data.length !== 1) throw new Error(`${operation} returned an invalid response.`);
  return data[0];
}

function groupRowFrom(value: unknown, operation: string): GroupRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('id' in value) || !('name' in value) || !('created_at' in value)
    || !('member_count' in value) || !('role' in value)
    || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
    || typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 80
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.member_count !== 'number' || !Number.isSafeInteger(value.member_count) || value.member_count < 1 || value.member_count > 6
    || (value.role !== 'owner' && value.role !== 'member')) {
    throw new Error(`${operation} returned an invalid group.`);
  }
  return {
    id: value.id,
    name: value.name,
    created_at: value.created_at,
    member_count: value.member_count,
    role: value.role,
  };
}

function toGroup(row: GroupRow): GroupSummary {
  return { id: row.id, name: row.name, createdAt: row.created_at, memberCount: row.member_count, role: row.role };
}

function groupsFrom(data: unknown): GroupSummary[] {
  if (!Array.isArray(data)) throw new Error('Group list returned an invalid response.');
  return data.map((row) => toGroup(groupRowFrom(row, 'Group list')));
}

function inviteFrom(data: unknown): InviteRow {
  const value = one(data, 'Invite creation');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('id' in value) || !('expires_at' in value)
    || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
    || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) {
    throw new Error('Invite creation returned an invalid response.');
  }
  return { id: value.id, expires_at: value.expires_at };
}

function inviteSummariesFrom(data: unknown): GroupInviteSummary[] {
  if (!Array.isArray(data)) throw new Error('Group invite list returned an invalid response.');
  return data.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('id' in value) || !('created_at' in value) || !('expires_at' in value)
      || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
      || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
      || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) {
      throw new Error('Group invite list returned an invalid invite.');
    }
    return { id: value.id, createdAt: value.created_at, expiresAt: value.expires_at };
  });
}

function leaveResultFrom(data: unknown): GroupLeaveResult {
  const value = one(data, 'Group departure');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('deleted' in value)
    || typeof value.deleted !== 'boolean') {
    throw new Error('Group departure returned an invalid response.');
  }
  const row = value as Record<string, unknown>;
  if (row.deleted) {
    if (row.id !== null || row.name !== null || row.created_at !== null
      || row.member_count !== 0 || row.role !== null) {
      throw new Error('Group departure returned an invalid deleted group.');
    }
    return { deleted: true, group: null };
  }
  const group = groupRowFrom(row, 'Group departure');
  return { deleted: false, group: toGroup(group) };
}

function profileRowFrom(value: unknown, expectedUserId: string): UserProfile {
  if (!isRecord(value) || value.user_id !== expectedUserId) {
    throw new Error('User profile returned an invalid response.');
  }
  return userProfileFrom({
    userId: value.user_id,
    displayName: value.display_name,
    avatarData: value.avatar_data,
  }, expectedUserId);
}

function membersFrom(data: unknown): GroupMember[] {
  if (!Array.isArray(data)) throw new Error('Group member list returned an invalid response.');
  return data.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('user_id' in value) || !('public_key' in value) || !('joined_at' in value) || !('role' in value)
      || typeof value.user_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.user_id)
      || typeof value.public_key !== 'string' || value.public_key.length < 1 || value.public_key.length > 4096
      || typeof value.joined_at !== 'string' || !Number.isFinite(Date.parse(value.joined_at))
      || (value.role !== 'owner' && value.role !== 'member')) {
      throw new Error('Group member list returned an invalid member.');
    }
    return { userId: value.user_id, publicKey: value.public_key, joinedAt: value.joined_at, role: value.role, profile: null };
  });
}

export async function loadCloudConfiguration(localConfigPath?: string): Promise<CloudConfigurationStatus> {
  let local: LocalCloudConfig = {};
  if (localConfigPath) {
    try {
      const parsed: unknown = JSON.parse(await readFile(localConfigPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local cloud configuration.');
      if (('supabaseUrl' in parsed && typeof parsed.supabaseUrl !== 'string')
        || ('supabaseAnonKey' in parsed && typeof parsed.supabaseAnonKey !== 'string')) {
        throw new Error('Invalid local cloud configuration.');
      }
      if ('supabaseUrl' in parsed && typeof parsed.supabaseUrl === 'string') local.supabaseUrl = parsed.supabaseUrl;
      if ('supabaseAnonKey' in parsed && typeof parsed.supabaseAnonKey === 'string') local.supabaseAnonKey = parsed.supabaseAnonKey;
    } catch (error) {
      const missingFile = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (!missingFile) throw new Error('Local cloud configuration could not be read.', { cause: error });
    }
  }
  const url = (process.env.LARP_SUPABASE_URL || local.supabaseUrl)?.trim();
  const anonKey = (process.env.LARP_SUPABASE_ANON_KEY || local.supabaseAnonKey)?.trim();
  if (anonKey) rejectAdministrativeKey(anonKey);
  const missing: ('url' | 'anonKey')[] = [];
  if (!url) missing.push('url');
  if (!anonKey) missing.push('anonKey');
  if (missing.length) return { status: 'not-configured', missing };
  if (!url || !anonKey) return { status: 'not-configured', missing: ['url', 'anonKey'] };
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Supabase URL in local configuration is invalid.'); }
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))
    || parsed.username || parsed.password) {
    throw new Error('Supabase URL must use HTTPS and must not contain credentials.');
  }
  return { status: 'configured', url, anonKey };
}

export type CloudSetup =
  | { status: 'not-configured'; missing: readonly ('url' | 'anonKey')[] }
  | { status: 'configured'; groups: SupabaseGroupsService };

export async function createCloudSetup(
  configPath: string | undefined,
  publicKey: string,
  authStoragePath: string,
): Promise<CloudSetup> {
  const configuration = await loadCloudConfiguration(configPath);
  if (configuration.status === 'not-configured') return configuration;
  const sessionStorage = createEncryptedAuthStorage(authStoragePath);
  const client = createClient(configuration.url, configuration.anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storage: sessionStorage,
    },
  });
  return { status: 'configured', groups: new SupabaseGroupsService(client, publicKey) };
}

export class SupabaseGroupsService {
  private signedIn = false;
  private signedInUserId: string | undefined;
  private readonly signalChannels = new Map<string, SignalChannelState>();
  constructor(private readonly client: SupabaseClient, private readonly publicKey: string) {}

  async signInAnonymously(): Promise<{ userId: string }> {
    const existing = await this.client.auth.getSession();
    if (existing.error) throw new Error(`Could not restore cloud sign-in: ${existing.error.message}`);
    let userId = existing.data.session?.user.id;
    if (!userId) {
      const { data, error } = await this.client.auth.signInAnonymously();
      if (error) throw new Error(`Anonymous cloud sign-in failed: ${error.message}`);
      if (!data.user) throw new Error('Anonymous cloud sign-in returned no user.');
      userId = data.user.id;
    }
    const registered = await this.client.rpc('register_identity', { p_public_key: this.publicKey });
    if (registered.error) throw new Error(`Cloud identity registration failed: ${registered.error.message}`);
    this.signedInUserId = userId;
    this.signedIn = true;
    return { userId };
  }

  async listGroups(): Promise<GroupSummary[]> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('list_my_groups');
    if (error) throw new Error(`Could not list cloud groups: ${error.message}`);
    return groupsFrom(data);
  }

  async createGroup(name: string): Promise<GroupSummary> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('create_group', { p_name: name });
    if (error) throw new Error(`Could not create cloud group: ${error.message}`);
    return toGroup(groupRowFrom(one(data, 'Group creation'), 'Group creation'));
  }

  async createInvite(groupId: string): Promise<GroupInvite> {
    this.requireSignIn();
    const code = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const { data, error } = await this.client.rpc('create_group_invite', { p_group_id: groupId, p_token_hash: tokenHash });
    if (error) throw new Error(`Could not create group invite: ${error.message}`);
    const row = inviteFrom(data);
    return { id: row.id, code, expiresAt: row.expires_at };
  }

  async revokeInvite(groupId: string, inviteId: string): Promise<void> {
    this.requireSignIn();
    const { error } = await this.client.rpc('revoke_group_invite', { p_group_id: groupId, p_invite_id: inviteId });
    if (error) throw new Error(`Could not revoke group invite: ${error.message}`);
  }

  async listInvites(groupId: string): Promise<GroupInviteSummary[]> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('list_group_invites', { p_group_id: groupId });
    if (error) throw new Error(`Could not list group invites: ${error.message}`);
    return inviteSummariesFrom(data);
  }

  async acceptInvite(code: string): Promise<GroupSummary> {
    this.requireSignIn();
    const tokenHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const { data, error } = await this.client.rpc('accept_group_invite', { p_token_hash: tokenHash });
    if (error) throw new Error(`Could not accept group invite: ${error.message}`);
    return toGroup(groupRowFrom(one(data, 'Invite acceptance'), 'Invite acceptance'));
  }

  async removeMember(groupId: string, memberUserId: string): Promise<void> {
    this.requireSignIn();
    const { error } = await this.client.rpc('remove_group_member', { p_group_id: groupId, p_member_user_id: memberUserId });
    if (error) throw new Error(`Could not remove group member: ${error.message}`);
  }

  async leaveGroup(groupId: string): Promise<GroupLeaveResult> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('leave_group', { p_group_id: groupId });
    if (error) throw new Error(`Could not leave cloud group: ${error.message}`);
    return leaveResultFrom(data);
  }

  async acquireShareLease(groupId: string): Promise<boolean> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('acquire_group_share_lease', { p_group_id: groupId });
    if (error) throw new Error(`Could not reserve screen sharing: ${error.message}`);
    if (typeof data !== 'boolean') throw new Error('Screen share reservation returned an invalid response.');
    return data;
  }

  async releaseShareLease(groupId: string): Promise<void> {
    this.requireSignIn();
    const { error } = await this.client.rpc('release_group_share_lease', { p_group_id: groupId });
    if (error) throw new Error(`Could not release screen share reservation: ${error.message}`);
  }

  async getMembers(groupId: string): Promise<GroupMember[]> {
    this.requireSignIn();
    const { data, error } = await this.client.rpc('list_group_members', { p_group_id: groupId });
    if (error) throw new Error(`Could not list group members: ${error.message}`);
    const members = membersFrom(data);
    const profilesByUserId = new Map<string, UserProfile>();
    if (members.length) {
      const { data: profileData, error: profileError } = await this.client
        .from('larp_user_profiles')
        .select('user_id, display_name, avatar_data')
        .in('user_id', members.map((member) => member.userId));
      if (profileError) throw new Error(`Could not list group member profiles: ${profileError.message}`);
      if (!Array.isArray(profileData)) throw new Error('Group member profiles returned an invalid response.');
      for (const value of profileData) {
        if (!isRecord(value) || typeof value.user_id !== 'string') {
          throw new Error('Group member profiles returned an invalid profile.');
        }
        const profile = profileRowFrom(value, value.user_id);
        profilesByUserId.set(profile.userId, profile);
      }
    }
    const membersWithProfiles = members.map((member) => ({
      ...member,
      profile: profilesByUserId.get(member.userId) ?? null,
    }));
    const active = this.signalChannels.get(groupId);
    if (active) {
      active.memberIds = new Set(members.map((member) => member.userId));
    }
    return membersWithProfiles;
  }

  async getMyProfile(): Promise<UserProfile | null> {
    this.requireSignIn();
    const userId = this.signedInUserId;
    if (!userId) throw new Error('The authenticated cloud user is unavailable.');
    const { data, error } = await this.client
      .from('larp_user_profiles')
      .select('user_id, display_name, avatar_data')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Could not read user profile: ${error.message}`);
    return data === null ? null : profileRowFrom(data, userId);
  }

  async saveMyProfile(profile: UserProfileUpdate): Promise<UserProfile> {
    this.requireSignIn();
    const userId = this.signedInUserId;
    if (!userId) throw new Error('The authenticated cloud user is unavailable.');
    const fields = normalizeProfileFields(profile.displayName, profile.avatarData);
    const { data, error } = await this.client
      .from('larp_user_profiles')
      .upsert({ user_id: userId, display_name: fields.displayName, avatar_data: fields.avatarData }, { onConflict: 'user_id' })
      .select('user_id, display_name, avatar_data')
      .single();
    if (error) throw new Error(`Could not save user profile: ${error.message}`);
    return profileRowFrom(data, userId);
  }

  async getTurnServers(groupId: string): Promise<TurnCredentialServer[]> {
    this.requireSignIn();
    const { data, error } = await this.client.functions.invoke('turn-credentials', { body: { groupId } });
    if (error) throw new Error(`Managed TURN credentials are unavailable: ${error.message}`);
    if (!isRecord(data) || !Array.isArray(data.servers) || data.servers.length > 4) {
      throw new Error('Managed TURN credentials returned an invalid response.');
    }
    return data.servers.map((raw): TurnCredentialServer => {
      if (!isRecord(raw)) throw new Error('Managed TURN credentials returned an invalid server.');
      const urls = typeof raw.urls === 'string' ? [raw.urls] : raw.urls;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4
        || urls.some((url) => typeof url !== 'string' || !/^turns?:/u.test(url) || url.length > 256)
        || typeof raw.username !== 'string' || raw.username.length < 1 || raw.username.length > 256
        || typeof raw.credential !== 'string' || raw.credential.length < 1 || raw.credential.length > 1024) {
        throw new Error('Managed TURN credentials returned an invalid server.');
      }
      return { urls, username: raw.username, credential: raw.credential };
    });
  }

  async subscribeRealtimeSignals(groupId: string, listener: SignalListener): Promise<() => Promise<void>> {
    if (typeof listener !== 'function') throw new TypeError('Signal listener is required.');
    const state = await this.ensureSignalChannel(groupId);
    state.listeners.add(listener);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      state.listeners.delete(listener);
      await this.releaseSignalChannel(groupId, state);
    };
  }
  async subscribeRealtimeMembers(
    groupId: string,
    listener: MembershipListener,
    onError: MembershipErrorListener,
  ): Promise<() => Promise<void>> {
    if (typeof listener !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Group membership listeners are required.');
    }
    const state = await this.ensureSignalChannel(groupId);
    const members = await this.getMembers(groupId);
    state.membershipListeners.add(listener);
    state.membershipErrorListeners.add(onError);
    listener(members);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      state.membershipListeners.delete(listener);
      state.membershipErrorListeners.delete(onError);
      await this.releaseSignalChannel(groupId, state);
    };
  }

  async sendRealtimeSignal(groupId: string, rawEnvelope: unknown): Promise<void> {
    this.requireSignIn();
    const parsed = validateProtocolEnvelope(rawEnvelope);
    if (!parsed.ok || !isTargetedSignal(parsed.envelope)) {
      throw new TypeError('Invalid targeted signaling envelope.');
    }
    const envelope = parsed.envelope;
    const userId = this.signedInUserId;
    if (!userId || envelope.groupId !== groupId || envelope.senderId !== userId) {
      throw new Error('Signaling sender or group does not match the authenticated session.');
    }
    if (Buffer.byteLength(JSON.stringify({ envelope }), 'utf8') > 64 * 1024) {
      throw new TypeError('Signaling envelope exceeds the permitted size.');
    }
    const state = await this.ensureSignalChannel(groupId);
    if (!state.memberIds.has(envelope.recipientId)) {
      throw new Error('Signaling recipient is not a member of this group.');
    }
    state.activeSends += 1;
    try {
      const status = await state.channel.send({
        type: 'broadcast',
        event: REALTIME_SIGNAL_EVENT,
        payload: { envelope },
      });
      if (status !== 'ok') throw new Error('O Supabase não confirmou o envio da sinalização.');
    } finally {
      state.activeSends -= 1;
      await this.releaseSignalChannel(groupId, state);
    }
  }

  private async ensureSignalChannel(groupId: string): Promise<SignalChannelState> {
    this.requireSignIn();
    const existing = this.signalChannels.get(groupId);
    if (existing) {
      await existing.opening;
      return existing;
    }

    const members = await this.getMembers(groupId);
    const memberIds = new Set(members.map((member) => member.userId));
    const userId = this.signedInUserId;
    if (!userId || !memberIds.has(userId)) throw new Error('Acesso de sinalização exige participação no grupo.');

    const channel = this.client.channel(`group:${groupId}`, {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    let openingSettled = false;
    let resolveOpening!: () => void;
    let rejectOpening!: (error: Error) => void;
    const opening = new Promise<void>((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    const openingTimer = setTimeout(() => {
      if (openingSettled) return;
      openingSettled = true;
      rejectOpening(new Error('Tempo esgotado ao abrir a sinalização privada.'));
    }, REALTIME_SUBSCRIBE_TIMEOUT_MS);
    let memberRefresh: Promise<GroupMember[]> | undefined;
    const refreshMembers = () => {
      if (!memberRefresh) {
        memberRefresh = this.getMembers(groupId).then((members) => {
          for (const listener of state.membershipListeners) listener(members);
          return members;
        }).catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : 'Could not refresh group membership.';
          for (const listener of state.membershipErrorListeners) listener(message);
          throw cause;
        }).finally(() => { memberRefresh = undefined; });
      }
      return memberRefresh;
    };
    const state: SignalChannelState = {
      channel,
      opening,
      listeners: new Set(),
      membershipListeners: new Set(),
      membershipErrorListeners: new Set(),
      memberIds,
      activeSends: 0,
    };
    channel.on('broadcast', { event: REALTIME_SIGNAL_EVENT }, ({ payload }) => {
      if (!isRecord(payload) || !('envelope' in payload)) return;
      const received = validateProtocolEnvelope(payload.envelope);
      if (!received.ok || !isTargetedSignal(received.envelope)) return;
      const envelope = received.envelope;
      if (envelope.groupId !== groupId || envelope.recipientId !== this.signedInUserId
        || envelope.senderId === this.signedInUserId) return;
      const deliver = (members: readonly GroupMember[]) => {
        if (!members.some((member) => member.userId === envelope.senderId)) return;
        for (const callback of state.listeners) callback(envelope.senderId, envelope);
      };
      if (!state.memberIds.has(envelope.senderId)) {
        void refreshMembers().then(deliver).catch(() => undefined);
        return;
      }
      for (const callback of state.listeners) callback(envelope.senderId, envelope);
    });
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'larp_group_members',
      filter: `group_id=eq.${groupId}`,
    }, () => { void refreshMembers().catch(() => undefined); });
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'larp_user_profiles',
    }, () => { void refreshMembers().catch(() => undefined); });
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED' && !openingSettled) {
        openingSettled = true;
        clearTimeout(openingTimer);
        resolveOpening();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        const message = error?.message ?? `A sinalização privada falhou: ${status}.`;
        if (!openingSettled) {
          openingSettled = true;
          clearTimeout(openingTimer);
          rejectOpening(new Error(message));
        } else {
          for (const listener of state.membershipErrorListeners) listener(message);
        }
        }
    });
    this.signalChannels.set(groupId, state);
    try {
      await opening;
      return state;
    } catch (error) {
      if (this.signalChannels.get(groupId) === state) {
        this.signalChannels.delete(groupId);
        await this.client.removeChannel(channel);
      }
      throw error;
    }
  }

  private async releaseSignalChannel(groupId: string, state: SignalChannelState): Promise<void> {
    if (state.listeners.size > 0 || state.membershipListeners.size > 0 || state.activeSends > 0
      || this.signalChannels.get(groupId) !== state) return;
    this.signalChannels.delete(groupId);
    await this.client.removeChannel(state.channel);
  }

  private requireSignIn(): void {
    if (!this.signedIn) throw new Error('Anonymous cloud sign-in is required before group operations.');
  }
}
