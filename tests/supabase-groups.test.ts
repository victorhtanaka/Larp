import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { groupPresenceFromSnapshot, SupabaseGroupsService } from '../src/main/services/supabase-groups';

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  avatar_data: string | null;
}

interface QueryResult {
  data: ProfileRow | null;
  error: { code: string; message: string } | null;
}

class ProfileQuery {
  private operation: 'insert' | 'update' | 'upsert' | undefined;
  private values: Partial<ProfileRow> = {};
  private userFilter: string | undefined;

  constructor(private readonly rows: Map<string, ProfileRow>, private readonly authenticatedUserId: string) {}

  insert(values: ProfileRow): this {
    this.operation = 'insert';
    this.values = values;
    return this;
  }

  update(values: Partial<ProfileRow>): this {
    this.operation = 'update';
    this.values = values;
    return this;
  }

  upsert(values: ProfileRow): this {
    this.operation = 'upsert';
    this.values = values;
    return this;
  }

  eq(column: string, value: string): this {
    assert.equal(column, 'user_id');
    this.userFilter = value;
    return this;
  }

  select(): this {
    return this;
  }

  single(): Promise<QueryResult> {
    return Promise.resolve(this.execute(true));
  }

  maybeSingle(): Promise<QueryResult> {
    return Promise.resolve(this.execute(false));
  }

  private execute(requireRow: boolean): QueryResult {
    if (this.operation === 'upsert') {
      return { data: null, error: { code: '42501', message: 'permission denied for table larp_user_profiles' } };
    }

    if (this.operation === 'insert') {
      const userId = this.values.user_id;
      if (!userId || userId !== this.authenticatedUserId) {
        return { data: null, error: { code: '42501', message: 'row-level security denied profile insert' } };
      }
      if (this.rows.has(userId)) {
        return { data: null, error: { code: '23505', message: 'duplicate profile user_id' } };
      }
      const row: ProfileRow = {
        user_id: userId,
        display_name: this.values.display_name ?? null,
        avatar_data: this.values.avatar_data ?? null,
      };
      this.rows.set(userId, row);
      return { data: { ...row }, error: null };
    }

    if (this.operation === 'update') {
      if ('user_id' in this.values) {
        return { data: null, error: { code: '42501', message: 'permission denied for user_id update' } };
      }
      const row = this.userFilter ? this.rows.get(this.userFilter) : undefined;
      if (!row || row.user_id !== this.authenticatedUserId) {
        return requireRow
          ? { data: null, error: { code: 'PGRST116', message: 'profile row not found' } }
          : { data: null, error: null };
      }
      const updated = { ...row, ...this.values };
      this.rows.set(updated.user_id, updated);
      return { data: { ...updated }, error: null };
    }

    return { data: null, error: { code: 'XX000', message: 'no profile operation was issued' } };
  }
}

test('profile save inserts new rows and updates existing rows without UPDATE on user_id', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const rows = new Map<string, ProfileRow>();
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: userId } } }, error: null }),
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      assert.equal(table, 'larp_user_profiles');
      return new ProfileQuery(rows, userId);
    },
  } as unknown as SupabaseClient;
  const service = new SupabaseGroupsService(client, 'test-public-key');
  await service.signInAnonymously();

  assert.deepEqual(await service.saveMyProfile({ displayName: 'Ana', avatarData: null }), {
    userId,
    displayName: 'Ana',
    avatarData: null,
  });
  assert.deepEqual(await service.saveMyProfile({ displayName: 'Ana Costa', avatarData: null }), {
    userId,
    displayName: 'Ana Costa',
    avatarData: null,
  });
  assert.equal(rows.get(userId)?.display_name, 'Ana Costa');
});

test('tracks group presence online after subscription and reconnect', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const groupId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const tracked: unknown[] = [];
  let onSubscribe: ((status: string) => void) | undefined;
  const channel = {
    on: () => channel,
    subscribe: (listener: (status: string) => void) => {
      onSubscribe = listener;
      listener('SUBSCRIBED');
      return channel;
    },
    track: async (payload: unknown) => {
      tracked.push(payload);
      return 'ok';
    },
    presenceState: () => ({}),
    untrack: async () => 'ok',
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: userId } } }, error: null }),
    },
    rpc: async (name: string) => name === 'list_group_members'
      ? {
        data: [{ user_id: userId, public_key: 'test-public-key', joined_at: '2026-01-01T00:00:00.000Z', role: 'owner' }],
        error: null,
      }
      : { data: null, error: null },
    from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
    channel: () => channel,
    removeChannel: async () => 'ok',
  } as unknown as SupabaseClient;
  const service = new SupabaseGroupsService(client, 'test-public-key');
  await service.signInAnonymously();

  const unsubscribe = await service.subscribeRealtimePresence(groupId, () => undefined, () => {
    assert.fail('presence subscription should not report an error');
  });
  const onlinePayload = { userId, status: 'online' };
  assert.deepEqual(tracked, [onlinePayload]);

  assert.ok(onSubscribe);
  onSubscribe('SUBSCRIBED');
  await Promise.resolve();
  assert.deepEqual(tracked, [onlinePayload, onlinePayload]);

  await unsubscribe();
});


test('presence snapshots aggregate sessions and filter untrusted or non-member entries', () => {
  const memberId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const otherMemberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const outsiderId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  assert.deepEqual(groupPresenceFromSnapshot({
    [memberId]: [
      { userId: memberId, status: 'away' },
      { userId: memberId, status: 'online' },
    ],
    [otherMemberId]: [
      { userId: otherMemberId, status: 'away' },
      { userId: otherMemberId, status: 'invalid' },
      { userId: outsiderId, status: 'online' },
    ],
    [outsiderId]: [{ userId: outsiderId, status: 'online' }],
  }, new Set([memberId, otherMemberId])), {
    [memberId]: 'online',
    [otherMemberId]: 'away',
  });
  assert.deepEqual(groupPresenceFromSnapshot(null, new Set([memberId])), {});
});

test('routes signed media-state envelopes only to group members', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const peerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const outsiderId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  const groupId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
  const delivered: unknown[] = [];
  const sent: unknown[] = [];
  const broadcastCallbacks: Array<(event: { payload: unknown }) => void> = [];
  const channel = {
    on: (type: string, filter: { event?: string }, callback: (event: { payload: unknown }) => void) => {
      if (type === 'broadcast' && filter.event === 'signal') broadcastCallbacks.push(callback);
      return channel;
    },
    subscribe: (listener: (status: string) => void) => {
      listener('SUBSCRIBED');
      return channel;
    },
    send: async (message: unknown) => {
      sent.push(message);
      return 'ok';
    },
    presenceState: () => ({}),
  };
  const members = [userId, peerId].map((memberId) => ({
    user_id: memberId,
    public_key: `key-${memberId}`,
    joined_at: '2026-01-01T00:00:00.000Z',
    role: memberId === userId ? 'owner' : 'member',
  }));
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: userId } } }, error: null }),
    },
    rpc: async (name: string) => name === 'list_group_members'
      ? { data: members, error: null }
      : { data: null, error: null },
    from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
    channel: () => channel,
    removeChannel: async () => 'ok',
  } as unknown as SupabaseClient;
  const service = new SupabaseGroupsService(client, 'test-public-key');
  await service.signInAnonymously();
  const unsubscribe = await service.subscribeRealtimeSignals(groupId, (senderId, envelope) => {
    delivered.push({ senderId, envelope });
  });
  const mediaState = {
    version: 1,
    kind: 'media-state',
    groupId,
    senderId: userId,
    recipientId: peerId,
    media: 'voice',
    active: true,
    signature: { algorithm: 'Ed25519', signature: 'AQ==' },
  };

  await service.sendRealtimeSignal(groupId, mediaState);
  assert.deepEqual(sent, [{
    type: 'broadcast',
    event: 'signal',
    payload: { envelope: mediaState },
  }]);
  await assert.rejects(service.sendRealtimeSignal(groupId, { ...mediaState, recipientId: outsiderId }), /not a member/u);
  await assert.rejects(service.sendRealtimeSignal(groupId, { ...mediaState, active: 'yes' }), /Invalid targeted signaling envelope/u);

  assert.equal(broadcastCallbacks.length, 1);
  broadcastCallbacks[0]({ payload: { envelope: { ...mediaState, senderId: peerId, recipientId: userId } } });
  broadcastCallbacks[0]({ payload: { envelope: { ...mediaState, senderId: outsiderId, recipientId: userId } } });
  broadcastCallbacks[0]({ payload: { envelope: { ...mediaState, senderId: peerId, recipientId: outsiderId } } });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    senderId: peerId,
    envelope: { ...mediaState, senderId: peerId, recipientId: userId },
  });

  await unsubscribe();
});
