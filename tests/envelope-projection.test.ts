import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { test } from 'node:test';
import { projectEnvelope } from '../src/main/envelope-projection';
import {
  WEBRTC_PROTOCOL_VERSION,
  envelopeSigningBytes,
  serializeStoredEnvelope,
  signProtocolEnvelope,
  type IdentitySigner,
  type SignedChatEnvelope,
} from '../src/shared/webrtc-protocol';

function createSigner(participantId: string): IdentitySigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    participantId,
    sign: async (bytes) => ({
      algorithm: 'Ed25519',
      signature: signBytes(null, Buffer.from(bytes), privateKey).toString('base64'),
    }),
  };
}

async function createChat(signer: IdentitySigner, content: string): Promise<SignedChatEnvelope> {
  return await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'chat',
    groupId: 'cloud-room',
    senderId: signer.participantId,
    messageId: `${signer.participantId}-message-1`,
    sequence: 1,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }, signer) as SignedChatEnvelope;
}

test('projection preserves opaque wire JSON and canonical stored envelope bytes', async () => {
  const signer = createSigner('peer-user');
  const envelope = await createChat(signer, 'left\uD800right');
  const envelopeJson = JSON.stringify(envelope);
  const projection = projectEnvelope(envelopeJson);

  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  assert.equal(projection.envelopeJson, envelopeJson);
  assert.equal(projection.storageJson, serializeStoredEnvelope(envelope, 'chat'));
  assert.deepEqual(Buffer.from(projection.signingBytesBase64, 'base64'), Buffer.from(envelopeSigningBytes(envelope)));
  assert.deepEqual(projection.header, {
    kind: 'chat', groupId: 'cloud-room', senderId: 'peer-user', recipientId: null,
    messageId: 'peer-user-message-1', sequence: 1, authorId: null, requestId: null,
    afterSequence: null, throughSequence: null, limit: null,
  });
  assert.match(projection.envelopeJson, /\\ud800/u);
});

test('projection recursively exposes only sync-batch chat messages', async () => {
  const signer = createSigner('peer-user');
  const message = await createChat(signer, 'sync');
  const envelope = await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'sync-batch',
    groupId: message.groupId,
    senderId: 'peer-user',
    authorId: 'peer-user',
    requestId: 'sync-request-1',
    afterSequence: 0,
    throughSequence: 1,
    messages: [message],
    complete: true,
  }, signer);
  const raw = JSON.stringify(envelope);
  const projection = projectEnvelope(raw);

  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  assert.equal(projection.envelopeJson, raw);
  assert.equal(projection.storageJson, null);
  assert.equal(projection.header.authorId, 'peer-user');
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0].header.kind, 'chat');
  assert.equal(projection.messages[0].storageJson, serializeStoredEnvelope(message, 'chat'));
});

test('projection returns the shared parser error code', () => {
  assert.deepEqual(projectEnvelope('{'), { ok: false, code: 'malformed-envelope' });
});
