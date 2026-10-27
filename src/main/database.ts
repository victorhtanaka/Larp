import Database from 'better-sqlite3';
import type { GroupMember, GroupSummary } from '../shared/cloud-contracts';
import type { SignedChatEnvelope } from '../shared/webrtc-protocol';
import { userProfileFrom } from './profile-validation';
import { createPeerMessageStore } from './peer-message-store';
import type { LocalMessageStore } from '../renderer/rtc/message-sync';

export interface LocalLarpDatabase {
  createMessageStore(localUserId: string): LocalMessageStore;
  replaceCloudCache(groups: readonly GroupSummary[], membersByGroup: ReadonlyMap<string, readonly GroupMember[]>): void;
  cacheCloudMembers(groupId: string, members: readonly GroupMember[]): void;
  getCachedCloudGroups(): GroupSummary[];
  getCachedCloudMembers(groupId: string): GroupMember[];
  getCachedMessages(groupId: string, perAuthorLimit?: number): Promise<SignedChatEnvelope[]>;
  close(): void;
}


const PEER_MESSAGE_SCHEMA = `
  CREATE TABLE peer_messages (
    message_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    envelope_json TEXT NOT NULL CHECK (length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 65536),
    UNIQUE (group_id, author_id, sequence),
    UNIQUE (group_id, message_id, sequence, author_id)
  );
  CREATE INDEX peer_messages_author_sequence
    ON peer_messages(group_id, author_id, sequence);

  CREATE TABLE peer_message_acks (
    group_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    author_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK (length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 65536),
    PRIMARY KEY (group_id, message_id, sequence, recipient_id),
    FOREIGN KEY (group_id, message_id, sequence, author_id)
      REFERENCES peer_messages(group_id, message_id, sequence, author_id) ON DELETE CASCADE
  );
`;

const CLOUD_CACHE_SCHEMA = `
  CREATE TABLE cached_cloud_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    created_at TEXT NOT NULL,
    member_count INTEGER NOT NULL CHECK (member_count BETWEEN 1 AND 6),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member'))
  );

  CREATE TABLE cached_cloud_members (
    group_id TEXT NOT NULL REFERENCES cached_cloud_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 1 AND 4096),
    joined_at TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX cached_cloud_members_by_user ON cached_cloud_members(user_id, group_id);
`;

function migrate(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number;
  if (currentVersion > 5) {
    throw new Error(`Versão de banco não suportada: ${currentVersion}`);
  }
  if (currentVersion === 5) return;

  const memberColumns = currentVersion >= 3
    ? new Set(
      (database.pragma('table_info(cached_cloud_members)') as Array<{ name: string }>)
        .map((column) => column.name),
    )
    : new Set<string>();

  database.transaction(() => {
    if (currentVersion <= 1) {
      database.exec(PEER_MESSAGE_SCHEMA);
      database.exec(CLOUD_CACHE_SCHEMA);
    } else if (currentVersion === 2) {
      database.exec(CLOUD_CACHE_SCHEMA);
    }
    if (currentVersion < 4) {
      database.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS participants; DROP TABLE IF EXISTS groups;');
    }
    if (!memberColumns.has('display_name')) {
      database.exec(`
        ALTER TABLE cached_cloud_members
          ADD COLUMN display_name TEXT
            CHECK (display_name IS NULL OR (display_name = trim(display_name) AND length(display_name) BETWEEN 1 AND 32));
      `);
    }
    if (!memberColumns.has('avatar_data')) {
      database.exec(`
        ALTER TABLE cached_cloud_members
          ADD COLUMN avatar_data TEXT
            CHECK (avatar_data IS NULL OR (length(avatar_data) BETWEEN 27 AND 66000 AND substr(avatar_data, 1, 23) = 'data:image/webp;base64,'));
      `);
    }
    database.pragma('user_version = 5');
  })();
}

export function createLarpDatabase(databasePath: string): LocalLarpDatabase {
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  migrate(database);

  const assertMemberList = (members: readonly GroupMember[]): void => {
    if (!Array.isArray(members) || members.length < 1 || members.length > 6
      || members.filter((member) => member.role === 'owner').length !== 1) {
      throw new TypeError('A lista de membros em cache é inválida.');
    }
    const seen = new Set<string>();
    for (const member of members) {
      if (!member || typeof member.userId !== 'string' || !member.userId || member.userId.length > 80
        || seen.has(member.userId) || typeof member.publicKey !== 'string' || !member.publicKey
        || member.publicKey.length > 4096 || typeof member.joinedAt !== 'string'
        || !Number.isFinite(Date.parse(member.joinedAt))
        || (member.role !== 'owner' && member.role !== 'member')) {
        throw new TypeError('A lista de membros em cache é inválida.');
      }
      if (member.profile !== null) userProfileFrom(member.profile, member.userId);
      seen.add(member.userId);
    }
  };
  const insertCachedMembers = (groupId: string, members: readonly GroupMember[]): void => {
    assertMemberList(members);
    database.prepare('DELETE FROM cached_cloud_members WHERE group_id = ?').run(groupId);
    const insert = database.prepare(`
      INSERT INTO cached_cloud_members (
        group_id, user_id, public_key, joined_at, role, display_name, avatar_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const member of members) {
      insert.run(
        groupId, member.userId, member.publicKey, member.joinedAt, member.role,
        member.profile?.displayName ?? null, member.profile?.avatarData ?? null,
      );
    }
  };
  const replaceCloudCache = (
    groups: readonly GroupSummary[],
    membersByGroup: ReadonlyMap<string, readonly GroupMember[]>,
  ): void => {
    if (!Array.isArray(groups)) throw new TypeError('A lista de grupos em cache é inválida.');
    const replace = database.transaction(() => {
      database.exec('DELETE FROM cached_cloud_groups');
      const insertGroup = database.prepare(`
        INSERT INTO cached_cloud_groups (id, name, created_at, member_count, role)
        VALUES (?, ?, ?, ?, ?)
      `);
      const seen = new Set<string>();
      for (const group of groups) {
        const members = membersByGroup.get(group.id);
        if (!group || typeof group.id !== 'string' || !group.id || group.id.length > 80
          || seen.has(group.id) || typeof group.name !== 'string' || !group.name.trim()
          || group.name.length > 80 || typeof group.createdAt !== 'string'
          || !Number.isFinite(Date.parse(group.createdAt)) || !Number.isSafeInteger(group.memberCount)
          || group.memberCount < 1 || group.memberCount > 6
          || (group.role !== 'owner' && group.role !== 'member')
          || !members || members.length !== group.memberCount) {
          throw new TypeError('Os dados do grupo em cache são inválidos.');
        }
        assertMemberList(members);
        if (members.some((member) => member.userId === undefined)) throw new TypeError('O grupo em cache tem um membro inválido.');
        seen.add(group.id);
        insertGroup.run(group.id, group.name, group.createdAt, group.memberCount, group.role);
        insertCachedMembers(group.id, members);
      }
    });
    replace();
  };
  const cacheCloudMembers = (groupId: string, members: readonly GroupMember[]): void => {
    if (typeof groupId !== 'string' || !groupId || groupId.length > 80) throw new TypeError('Grupo inválido.');
    const update = database.transaction(() => {
      if (!database.prepare('SELECT 1 FROM cached_cloud_groups WHERE id = ?').get(groupId)) return;
      insertCachedMembers(groupId, members);
    });
    update();
  };
  const getCachedCloudGroups = (): GroupSummary[] => database.prepare(`
    SELECT id, name, created_at AS createdAt, member_count AS memberCount, role
    FROM cached_cloud_groups ORDER BY created_at, id
  `).all() as GroupSummary[];
  const getCachedCloudMembers = (groupId: string): GroupMember[] => {
    const rows = database.prepare(`
      SELECT
        user_id AS userId,
        public_key AS publicKey,
        joined_at AS joinedAt,
        role,
        display_name AS displayName,
        avatar_data AS avatarData
      FROM cached_cloud_members WHERE group_id = ? ORDER BY joined_at, user_id
    `).all(groupId) as Array<{
      userId: string;
      publicKey: string;
      joinedAt: string;
      role: 'owner' | 'member';
      displayName: string | null;
      avatarData: string | null;
    }>;
    return rows.map(({ displayName, avatarData, ...member }) => ({
      ...member,
      profile: displayName === null && avatarData === null
        ? null
        : userProfileFrom({ userId: member.userId, displayName, avatarData }, member.userId),
    }));
  };
  const getCachedMessages = async (groupId: string, perAuthorLimit = 100): Promise<SignedChatEnvelope[]> => {
    if (typeof groupId !== 'string' || !groupId || groupId.length > 80
      || !Number.isSafeInteger(perAuthorLimit) || perAuthorLimit < 1 || perAuthorLimit > 100) {
      throw new TypeError('Consulta do histórico em cache inválida.');
    }
    const members = getCachedCloudMembers(groupId);
    if (members.length === 0) return [];
    const store = createPeerMessageStore(database, members[0].userId);
    const messages: SignedChatEnvelope[] = [];
    for (const member of members) {
      const through = await store.getHighestContiguousSequence(groupId, member.userId);
      let after = Math.max(0, through - perAuthorLimit);
      while (after < through) {
        const batch = await store.readMissing(groupId, member.userId, after, through, Math.min(20, perAuthorLimit));
        if (!batch.length) break;
        for (const message of batch) {
          if (message.groupId !== groupId || message.senderId !== member.userId) {
            throw new Error('Uma mensagem em cache não corresponde ao grupo e autor.');
          }
        }
        messages.push(...batch);
        after = batch[batch.length - 1].sequence;
      }
    }
    return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  };

  return {
    createMessageStore: (localUserId) => createPeerMessageStore(database, localUserId),
    replaceCloudCache,
    cacheCloudMembers,
    getCachedCloudGroups,
    getCachedCloudMembers,
    getCachedMessages,
    close: () => database.close(),
  };
}
