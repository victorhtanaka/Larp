import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { groupPresenceFromSnapshot, requireGroupPresenceStatus, SupabaseGroupsService } from '../src/main/services/supabase-groups';

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

test('presence status accepts only online and away', () => {
  assert.equal(requireGroupPresenceStatus('online'), 'online');
  assert.equal(requireGroupPresenceStatus('away'), 'away');
  for (const invalid of ['offline', 'ONLINE', '', null, undefined, 1, {}]) {
    assert.throws(() => requireGroupPresenceStatus(invalid), TypeError);
  }
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
