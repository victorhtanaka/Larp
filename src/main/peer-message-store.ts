import type Database from 'better-sqlite3';
import { MAX_ENVELOPE_BYTES, parseProtocolEnvelope, type SignedAckEnvelope, type SignedChatEnvelope } from '../shared/webrtc-protocol';
import type { IncomingMessageResult, LocalMessageStore } from '../renderer/rtc/message-sync';

type StoredMessage = { envelope_json: string; sequence: number };
type StoredAck = { envelope_json: string };

const encoder = new TextEncoder();
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

function serializeEnvelope(value: unknown, kind: 'chat' | 'ack'): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('Invalid signed message envelope.');
  }
  if (typeof serialized !== 'string' || encoder.encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    throw new TypeError('Signed message envelope exceeds the permitted size.');
  }
  const parsed = parseProtocolEnvelope(serialized);
  if (!parsed.ok || parsed.envelope.kind !== kind) {
    throw new TypeError('Invalid signed message envelope.');
  }
  const envelope = parsed.envelope;
  const canonical = envelope.kind === 'chat'
    ? {
      version: envelope.version,
      kind: envelope.kind,
      groupId: envelope.groupId,
      senderId: envelope.senderId,
      messageId: envelope.messageId,
      sequence: envelope.sequence,
      content: envelope.content,
      createdAt: envelope.createdAt,
      signature: envelope.signature,
    }
    : {
      version: envelope.version,
      kind: envelope.kind,
      groupId: envelope.groupId,
      senderId: envelope.senderId,
      messageId: envelope.messageId,
      sequence: envelope.sequence,
      signature: envelope.signature,
    };
  return JSON.stringify(canonical);
}

function validateSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new TypeError('Invalid message sequence.');
  }
}

function validateRange(afterSequence: number, throughSequence: number, limit: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > MAX_SEQUENCE) {
    throw new TypeError('Invalid message range.');
  }
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || throughSequence > MAX_SEQUENCE) {
    throw new TypeError('Invalid message range.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError('Invalid message limit.');
  }
}

export function createPeerMessageStore(database: Database.Database, localUserId: string): LocalMessageStore {
  if (typeof localUserId !== 'string' || !localUserId || encoder.encode(localUserId).byteLength > 128) {
    throw new TypeError('Invalid local user ID.');
  }

  const findById = database.prepare(
    'SELECT envelope_json, group_id, author_id, sequence FROM peer_messages WHERE message_id = ?',
  );
  const findBySequence = database.prepare(
    'SELECT envelope_json, message_id, group_id, author_id, sequence FROM peer_messages WHERE group_id = ? AND author_id = ? AND sequence = ?',
  );
  const insertMessage = database.prepare(
    'INSERT INTO peer_messages (message_id, group_id, author_id, sequence, envelope_json) VALUES (?, ?, ?, ?, ?)',
  );

  const storeChat = database.transaction((message: SignedChatEnvelope, serialized: string): IncomingMessageResult => {
    const byId = findById.get(message.messageId) as (StoredMessage & {
      group_id: string; author_id: string;
    }) | undefined;
    const bySequence = findBySequence.get(message.groupId, message.senderId, message.sequence) as
      (StoredMessage & { message_id: string }) | undefined;
    const exactById = byId && byId.group_id === message.groupId && byId.author_id === message.senderId &&
      byId.sequence === message.sequence && byId.envelope_json === serialized;
    if (exactById) return 'duplicate';
    if (byId || bySequence) return 'conflict';
    insertMessage.run(message.messageId, message.groupId, message.senderId, message.sequence, serialized);
    return 'inserted';
  });

  return {
    async persistBeforeSend(message): Promise<void> {
      if (message.senderId !== localUserId) throw new Error('Outbound message is not authored by the local user.');
      const serialized = serializeEnvelope(message, 'chat');
      validateSequence(message.sequence);
      const result = storeChat(message, serialized);
      if (result === 'conflict') throw new Error('Message ID or author sequence is already occupied.');
    },

    async persistVerifiedIncoming(message): Promise<IncomingMessageResult> {
      const serialized = serializeEnvelope(message, 'chat');
      validateSequence(message.sequence);
      return storeChat(message, serialized);
    },

    async readMissing(groupId, authorId, afterSequence, throughSequence, limit): Promise<readonly SignedChatEnvelope[]> {
      validateRange(afterSequence, throughSequence, limit);
      if (!groupId || !authorId || throughSequence <= afterSequence) return [];
      const rows = database.prepare(`
        SELECT envelope_json, sequence FROM peer_messages
        WHERE group_id = ? AND author_id = ? AND sequence > ? AND sequence <= ?
        ORDER BY sequence LIMIT ?
      `).all(groupId, authorId, afterSequence, throughSequence, limit) as StoredMessage[];
      const contiguous: SignedChatEnvelope[] = [];
      let expected = afterSequence + 1;
      for (const row of rows) {
        if (row.sequence !== expected) break;
        const parsed = parseProtocolEnvelope(row.envelope_json);
        if (!parsed.ok || parsed.envelope.kind !== 'chat') throw new Error('Stored message envelope is invalid.');
        contiguous.push(parsed.envelope);
        expected += 1;
      }
      return contiguous;
    },

    async persistRecipientAck(acknowledgement: SignedAckEnvelope): Promise<void> {
      const serialized = serializeEnvelope(acknowledgement, 'ack');
      validateSequence(acknowledgement.sequence);
      const persistAck = database.transaction(() => {
        const message = database.prepare(`
          SELECT 1 FROM peer_messages
          WHERE group_id = ? AND message_id = ? AND sequence = ? AND author_id = ?
        `).get(acknowledgement.groupId, acknowledgement.messageId, acknowledgement.sequence, localUserId);
        if (!message) throw new Error('Acknowledgement does not match a locally authored message.');
        const existing = database.prepare(`
          SELECT envelope_json FROM peer_message_acks
          WHERE group_id = ? AND message_id = ? AND sequence = ? AND recipient_id = ?
        `).get(acknowledgement.groupId, acknowledgement.messageId, acknowledgement.sequence, acknowledgement.senderId) as
          StoredAck | undefined;
        if (existing) return;
        database.prepare(`
          INSERT INTO peer_message_acks
            (group_id, message_id, sequence, author_id, recipient_id, envelope_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          acknowledgement.groupId, acknowledgement.messageId, acknowledgement.sequence,
          localUserId, acknowledgement.senderId, serialized,
        );
      });
      persistAck();
    },

    async getHighestContiguousSequence(groupId, authorId): Promise<number> {
      const rows = database.prepare(`
        SELECT sequence FROM peer_messages WHERE group_id = ? AND author_id = ? ORDER BY sequence
      `).all(groupId, authorId) as Array<{ sequence: number }>;
      let expected = 1;
      for (const row of rows) {
        if (row.sequence !== expected) break;
        expected += 1;
      }
      return expected - 1;
    },
  };
}
