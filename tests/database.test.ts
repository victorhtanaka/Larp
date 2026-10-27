import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { GroupMember, GroupSummary } from '../src/shared/cloud-contracts';
import type { SignedAckEnvelope, SignedChatEnvelope } from '../src/shared/webrtc-protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLarpDatabase } from '../src/main/database';

function createCloudCacheFixture(): { group: GroupSummary; members: GroupMember[] } {
  const group: GroupSummary = {
    id: 'cloud-room',
    name: 'Sala privada',
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 2,
    role: 'owner',
  };
  const members: GroupMember[] = [
    { userId: 'owner-user', publicKey: 'owner-public-key', joinedAt: '2026-01-01T00:00:00.000Z', role: 'owner', profile: null },
    {
      userId: 'member-user',
      publicKey: 'member-public-key',
      joinedAt: '2026-01-02T00:00:00.000Z',
      role: 'member',
      profile: {
        userId: 'member-user',
        displayName: 'Membro',
        avatarData: 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89',
      },
    },
  ];
  return { group, members };
}

function signedMessage(senderId: string, sequence: number): SignedChatEnvelope {
  return {
    version: 1,
    kind: 'chat',
    groupId: 'cloud-room',
    senderId,
    messageId: `${senderId}-message-${sequence}`,
    sequence,
    content: `Mensagem ${sequence}`,
    createdAt: new Date(Date.UTC(2026, 0, sequence)).toISOString(),
    signature: { algorithm: 'Ed25519', signature: 'AQ==' },
  };
}

test('banco novo usa versão 5 e não cria tabelas de conteúdo local', () => {
  const directory = mkdtempSync(join(tmpdir(), 'larp-db-v5-'));
  const databasePath = join(directory, 'larp.sqlite');
  const database = createLarpDatabase(databasePath);

  try {
    assert.deepEqual(database.getCachedCloudGroups(), []);
    const sqlite = new Database(databasePath, { readonly: true });
    try {
      assert.equal(sqlite.pragma('user_version', { simple: true }), 5);
      const demoTables = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('groups', 'participants', 'messages')
        ORDER BY name
      `).all();
      assert.deepEqual(demoTables, []);
    } finally {
      sqlite.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('histórico P2P preserva prefixo contíguo e migra o cache cloud de v2 para v5', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'larp-cache-'));
  const databasePath = join(directory, 'larp.sqlite');
  let database = createLarpDatabase(databasePath);
  let databaseOpen = true;
  const { group, members } = createCloudCacheFixture();

  try {
    database.replaceCloudCache([group], new Map([[group.id, members]]));
    const store = database.createMessageStore('owner-user');
    await store.persistBeforeSend(signedMessage('owner-user', 1));
    assert.equal(await store.persistVerifiedIncoming(signedMessage('owner-user', 1)), 'duplicate');
    await store.persistVerifiedIncoming(signedMessage('owner-user', 3));
    assert.deepEqual((await database.getCachedMessages(group.id)).map((message) => message.sequence), [1]);

    await store.persistVerifiedIncoming(signedMessage('owner-user', 2));
    assert.deepEqual((await database.getCachedMessages(group.id)).map((message) => message.sequence), [1, 2, 3]);

    assert.throws(() => database.replaceCloudCache(
      [{ ...group, memberCount: 3 }],
      new Map([[group.id, members]]),
    ));
    assert.deepEqual(database.getCachedCloudGroups(), [group]);

    database.close();
    databaseOpen = false;
    const legacy = new Database(databasePath);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('DROP TABLE cached_cloud_members; DROP TABLE cached_cloud_groups; PRAGMA user_version = 2;');
    legacy.close();

    database = createLarpDatabase(databasePath);
    databaseOpen = true;
    database.replaceCloudCache([group], new Map([[group.id, members]]));
    assert.deepEqual((await database.getCachedMessages(group.id)).map((message) => message.sequence), [1, 2, 3]);
    const migrated = new Database(databasePath, { readonly: true });
    assert.equal(migrated.pragma('user_version', { simple: true }), 5);
    migrated.close();
  } finally {
    if (databaseOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migração v3 remove conteúdo local e preserva cache cloud, mensagens P2P e ACKs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'larp-v3-'));
  const databasePath = join(directory, 'larp.sqlite');
  let database = createLarpDatabase(databasePath);
  let databaseOpen = true;
  const { group, members } = createCloudCacheFixture();
  const message = signedMessage('owner-user', 1);
  const acknowledgement: SignedAckEnvelope = {
    version: 1,
    kind: 'ack',
    groupId: group.id,
    senderId: 'member-user',
    messageId: message.messageId,
    sequence: message.sequence,
    signature: { algorithm: 'Ed25519', signature: 'Ag==' },
  };

  try {
    database.replaceCloudCache([group], new Map([[group.id, members]]));
    const store = database.createMessageStore('owner-user');
    await store.persistBeforeSend(message);
    await store.persistRecipientAck(acknowledgement);
    database.close();
    databaseOpen = false;

    const legacy = new Database(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE participants (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id)
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id),
          content TEXT NOT NULL
        );
        INSERT INTO groups VALUES ('demo-group', 'Grupo legado');
        INSERT INTO participants VALUES ('demo-member', 'demo-group');
        INSERT INTO messages VALUES ('demo-note', 'demo-group', 'anotação legada');
        ALTER TABLE cached_cloud_members DROP COLUMN avatar_data;
        ALTER TABLE cached_cloud_members DROP COLUMN display_name;
        PRAGMA user_version = 3;
      `);
    } finally {
      legacy.close();
    }

    database = createLarpDatabase(databasePath);
    databaseOpen = true;
    assert.deepEqual(database.getCachedCloudGroups(), [group]);
    assert.deepEqual(database.getCachedCloudMembers(group.id), members.map((member) => ({ ...member, profile: null })));
    database.cacheCloudMembers(group.id, members);
    assert.deepEqual(database.getCachedCloudMembers(group.id), members);
    assert.deepEqual(
      (await database.getCachedMessages(group.id)).map((cachedMessage) => cachedMessage.messageId),
      [message.messageId],
    );
    database.close();
    databaseOpen = false;

    const migrated = new Database(databasePath, { readonly: true });
    try {
      assert.equal(migrated.pragma('user_version', { simple: true }), 5);
      const demoTables = migrated.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('groups', 'participants', 'messages')
        ORDER BY name
      `).all();
      assert.deepEqual(demoTables, []);
      const storedAck = migrated.prepare(
        'SELECT envelope_json FROM peer_message_acks WHERE message_id = ?',
      ).get(message.messageId) as { envelope_json: string } | undefined;
      assert.ok(storedAck);
      assert.deepEqual(JSON.parse(storedAck.envelope_json), acknowledgement);
    } finally {
      migrated.close();
    }
  } finally {
    if (databaseOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('migração v4 para v5 preserva dados existentes e armazena perfis no cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'larp-v4-'));
  const databasePath = join(directory, 'larp.sqlite');
  let database = createLarpDatabase(databasePath);
  let databaseOpen = true;
  const { group, members } = createCloudCacheFixture();
  const message = signedMessage('owner-user', 1);
  const acknowledgement: SignedAckEnvelope = {
    version: 1,
    kind: 'ack',
    groupId: group.id,
    senderId: 'member-user',
    messageId: message.messageId,
    sequence: message.sequence,
    signature: { algorithm: 'Ed25519', signature: 'Ag==' },
  };

  try {
    database.replaceCloudCache([group], new Map([[group.id, members]]));
    const store = database.createMessageStore('owner-user');
    await store.persistBeforeSend(message);
    await store.persistRecipientAck(acknowledgement);
    database.close();
    databaseOpen = false;

    const legacy = new Database(databasePath);
    try {
      legacy.exec(`
        ALTER TABLE cached_cloud_members DROP COLUMN avatar_data;
        ALTER TABLE cached_cloud_members DROP COLUMN display_name;
        PRAGMA user_version = 4;
      `);
    } finally {
      legacy.close();
    }

    database = createLarpDatabase(databasePath);
    databaseOpen = true;
    assert.deepEqual(database.getCachedCloudGroups(), [group]);
    const legacyMembers = members.map((member) => ({ ...member, profile: null }));
    assert.deepEqual(database.getCachedCloudMembers(group.id), legacyMembers);
    assert.deepEqual(
      (await database.getCachedMessages(group.id)).map((cachedMessage) => cachedMessage.messageId),
      [message.messageId],
    );
    database.cacheCloudMembers(group.id, members);
    assert.deepEqual(database.getCachedCloudMembers(group.id), members);
    database.close();
    databaseOpen = false;

    database = createLarpDatabase(databasePath);
    databaseOpen = true;
    assert.deepEqual(database.getCachedCloudMembers(group.id), members);
    database.close();
    databaseOpen = false;

    const migrated = new Database(databasePath, { readonly: true });
    try {
      assert.equal(migrated.pragma('user_version', { simple: true }), 5);
      const storedAck = migrated.prepare(
        'SELECT envelope_json FROM peer_message_acks WHERE message_id = ?',
      ).get(message.messageId) as { envelope_json: string } | undefined;
      assert.ok(storedAck);
      assert.deepEqual(JSON.parse(storedAck.envelope_json), acknowledgement);
    } finally {
      migrated.close();
    }
  } finally {
    if (databaseOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
