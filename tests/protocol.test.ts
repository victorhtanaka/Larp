import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  WEBRTC_PROTOCOL_VERSION,
  parseProtocolEnvelope,
  signProtocolEnvelope,
  type IdentitySigner,
  type IdentityVerifier,
  type SignedChatEnvelope,
  type SignedMediaStateEnvelope,
  type SignedProtocolEnvelope,
  verifyProtocolEnvelope,
} from '../src/shared/webrtc-protocol';
import { PeerMesh } from '../src/renderer/rtc/peer-mesh';
import { MessageSynchronizer, type LocalMessageStore } from '../src/renderer/rtc/message-sync';

const groupId = 'cloud-room';
const localId = 'local-user';
const peerId = 'peer-user';

function createSigner(participantId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): IdentitySigner {
  return {
    participantId,
    sign: async (bytes) => ({
      algorithm: 'Ed25519',
      signature: signBytes(null, Buffer.from(bytes), privateKey).toString('base64'),
    }),
  };
}

function createIdentity() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey,
  };
}

async function createChatMessage(sequence: number, signer: IdentitySigner, content = `mensagem-${sequence}`): Promise<SignedChatEnvelope> {
  return await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'chat',
    groupId,
    senderId: signer.participantId,
    messageId: `${signer.participantId}-message-${sequence}`,
    sequence,
    content,
    createdAt: new Date(Date.UTC(2026, 0, sequence)).toISOString(),
  }, signer) as SignedChatEnvelope;
}

function createMemoryStore() {
  const messages = new Map<string, Map<number, SignedChatEnvelope>>();
  const byAuthor = (group: string, author: string) => {
    const key = `${group}\u0000${author}`;
    let authored = messages.get(key);
    if (!authored) {
      authored = new Map();
      messages.set(key, authored);
    }
    return authored;
  };
  const store: LocalMessageStore = {
    async persistBeforeSend(_message) {
      throw new Error('This test store accepts incoming chat only.');
    },
    async persistVerifiedIncoming(message) {
      const authored = byAuthor(message.groupId, message.senderId);
      const bySequence = authored.get(message.sequence);
      const byId = [...authored.values()].find((candidate) => candidate.messageId === message.messageId);
      if (bySequence || byId) {
        return bySequence && JSON.stringify(bySequence) === JSON.stringify(message) ? 'duplicate' : 'conflict';
      }
      authored.set(message.sequence, message);
      return 'inserted';
    },
    async readMissing(requestedGroup, author, after, through, limit) {
      const authored = byAuthor(requestedGroup, author);
      const result: SignedChatEnvelope[] = [];
      for (let sequence = after + 1; sequence <= through && result.length < limit; sequence += 1) {
        const message = authored.get(sequence);
        if (!message) break;
        result.push(message);
      }
      return result;
    },
    async persistRecipientAck() {},
    async getHighestContiguousSequence(requestedGroup, author) {
      const authored = byAuthor(requestedGroup, author);
      let sequence = 0;
      while (authored.has(sequence + 1)) sequence += 1;
      return sequence;
    },
  };
  return { store, count: () => [...messages.values()].reduce((sum, authored) => sum + authored.size, 0) };
}

function createHarness() {
  const localIdentity = createIdentity();
  const peerIdentity = createIdentity();
  const keys = new Map([[localId, localIdentity.publicKey], [peerId, peerIdentity.publicKey]]);
  const verifier: IdentityVerifier = {
    verify: async (_participantId, bytes, signature, publicKey) => {
      if (!publicKey) return false;
      try {
        return verifyBytes(null, Buffer.from(bytes), createPublicKey(publicKey), Buffer.from(signature.signature, 'base64'));
      } catch {
        return false;
      }
    },
  };
  const localSigner = createSigner(localId, localIdentity.privateKey);
  const peerSigner = createSigner(peerId, peerIdentity.privateKey);
  const memory = createMemoryStore();
  const ordered: number[] = [];
  const protocolErrors: string[] = [];
  const sent: Array<{ target: string; kind: string; envelope: SignedProtocolEnvelope }> = [];
  const synchronizer = new MessageSynchronizer({
    groupId,
    localParticipantId: localId,
    signer: localSigner,
    verifier,
    store: memory.store,
    isGroupMember: async (requestedGroup, participantId) => requestedGroup === groupId && keys.has(participantId),
    getGroupMemberIds: async () => [localId, peerId],
    getMemberPublicKey: async (requestedGroup, participantId) => requestedGroup === groupId ? keys.get(participantId) : undefined,
    getPeerIds: () => [peerId],
    sendToPeer: async (target, envelope) => { sent.push({ target, kind: envelope.kind, envelope }); },
    callbacks: {
      onOrderedMessage: (message) => ordered.push(message.sequence),
      onProtocolError: (_participantId, code) => protocolErrors.push(code),
    },
  });
  return { synchronizer, peerSigner, memory, ordered, protocolErrors, sent };
}

test('verifica assinaturas Ed25519 e rejeita conteúdo alterado e versão incompatível', async () => {
  const harness = createHarness();
  const authentic = await createChatMessage(1, harness.peerSigner);
  const tampered = { ...authentic, content: 'conteúdo modificado sem nova assinatura' };

  await harness.synchronizer.receive(peerId, JSON.stringify(tampered));
  assert.equal(harness.memory.count(), 0);
  assert.deepEqual(harness.protocolErrors, ['invalid-signature']);

  const incompatible = parseProtocolEnvelope(JSON.stringify({ ...authentic, version: WEBRTC_PROTOCOL_VERSION + 1 }));
  assert.deepEqual(incompatible, { ok: false, code: 'version-mismatch' });
  await harness.synchronizer.receive(peerId, JSON.stringify({ ...authentic, version: WEBRTC_PROTOCOL_VERSION + 1 }));
  assert.equal(harness.protocolErrors.at(-1), 'version-mismatch');
});

test('persiste duplicatas idempotentes e só publica mensagens na ordem do autor', async () => {
  const harness = createHarness();
  const message2 = await createChatMessage(2, harness.peerSigner);
  const message1 = await createChatMessage(1, harness.peerSigner);
  await harness.synchronizer.receive(peerId, JSON.stringify(message2));
  assert.deepEqual(harness.ordered, []);
  await harness.synchronizer.receive(peerId, JSON.stringify(message1));
  assert.deepEqual(harness.ordered, [1, 2]);
  assert.equal(harness.memory.count(), 2);

  await harness.synchronizer.receive(peerId, JSON.stringify(message1));
  assert.deepEqual(harness.ordered, [1, 2]);
  assert.equal(harness.memory.count(), 2);

  const conflictingSequence = await createChatMessage(2, harness.peerSigner, 'sequência reutilizada');
  await harness.synchronizer.receive(peerId, JSON.stringify(conflictingSequence));
  assert.equal(harness.protocolErrors.at(-1), 'duplicate-id-conflict');
  assert.equal(harness.memory.count(), 2);
  assert.ok(harness.sent.some((entry) => entry.target === peerId && entry.kind === 'sync-request'));
});

test('notifica uma mensagem remota nova uma vez e não notifica duplicatas nem lotes de sincronização', async () => {
  const live = createHarness();
  const liveMessage = await createChatMessage(1, live.peerSigner);
  await live.synchronizer.receive(peerId, JSON.stringify(liveMessage));
  assert.deepEqual(live.ordered, [1]);
  await live.synchronizer.receive(peerId, JSON.stringify(liveMessage));
  assert.deepEqual(live.ordered, [1]);

  const synchronized = createHarness();
  await synchronized.synchronizer.synchronizePeer(peerId);
  const request = synchronized.sent.find((entry) => entry.kind === 'sync-request'
    && entry.envelope.kind === 'sync-request'
    && entry.envelope.authorId === peerId)?.envelope;
  assert.ok(request?.kind === 'sync-request');
  const historyMessage = await createChatMessage(1, synchronized.peerSigner);
  const batch = await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'sync-batch',
    groupId,
    senderId: peerId,
    authorId: peerId,
    requestId: request.requestId,
    afterSequence: request.afterSequence,
    throughSequence: request.throughSequence,
    messages: [historyMessage],
    complete: true,
  }, synchronized.peerSigner);
  await synchronized.synchronizer.receive(peerId, JSON.stringify(batch));
  assert.deepEqual(synchronized.ordered, []);
  await synchronized.synchronizer.receive(peerId, JSON.stringify(historyMessage));
  assert.deepEqual(synchronized.ordered, []);
});

test('valida envelopes direcionados de estado de mídia sem tolerar campos inválidos', async () => {
  const identity = createIdentity();
  const signer = createSigner(localId, identity.privateKey);
  const envelope = await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'media-state',
    groupId,
    senderId: localId,
    recipientId: peerId,
    media: 'voice',
    active: true,
  }, signer);

  assert.deepEqual(parseProtocolEnvelope(JSON.stringify(envelope)), { ok: true, envelope });
  for (const invalid of [
    { ...envelope, media: 'microphone' },
    { ...envelope, active: 1 },
    { ...envelope, recipientId: '' },
    { ...envelope, unexpected: true },
  ]) {
    assert.deepEqual(parseProtocolEnvelope(JSON.stringify(invalid)), { ok: false, code: 'malformed-envelope' });
  }
});

test('routes only member-authenticated media state without allocating a peer connection', async () => {
  const localIdentity = createIdentity();
  const peerIdentity = createIdentity();
  const outsiderIdentity = createIdentity();
  const signer = createSigner(localId, localIdentity.privateKey);
  const peerSigner = createSigner(peerId, peerIdentity.privateKey);
  const outsiderSigner = createSigner('outsider', outsiderIdentity.privateKey);
  const keys = new Map([[localId, localIdentity.publicKey], [peerId, peerIdentity.publicKey]]);
  const verifier: IdentityVerifier = {
    verify: async (_participantId, bytes, signature, publicKey) => {
      if (!publicKey) return false;
      try {
        return verifyBytes(null, Buffer.from(bytes), createPublicKey(publicKey), Buffer.from(signature.signature, 'base64'));
      } catch {
        return false;
      }
    },
  };
  let receiveSignal: ((transportPeerId: string, message: unknown) => void) | undefined;
  const sent: Array<{ peerId: string; envelope: SignedProtocolEnvelope }> = [];
  const mediaStates: Array<{ peerId: string; media: 'voice' | 'screen'; active: boolean }> = [];
  const mesh = new PeerMesh({
    groupId,
    localParticipantId: localId,
    signaling: {
      send: async (target, envelope) => { sent.push({ peerId: target, envelope }); },
      subscribe: (listener) => {
        receiveSignal = listener;
        return () => { receiveSignal = undefined; };
      },
    },
    signer,
    verifier,
    store: createMemoryStore().store,
    isGroupMember: async (requestedGroup, participantId) => requestedGroup === groupId && keys.has(participantId),
    getGroupMemberIds: async () => [localId, peerId],
    getMemberPublicKey: async (requestedGroup, participantId) => requestedGroup === groupId ? keys.get(participantId) : undefined,
    callbacks: { onMediaState: (sender, media, active) => mediaStates.push({ peerId: sender, media, active }) },
  });
  const signState = async (
    stateSigner: IdentitySigner,
    values: { requestedGroup?: string; recipientId?: string; media?: 'voice' | 'screen'; active?: boolean } = {},
  ): Promise<SignedMediaStateEnvelope> => await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'media-state',
    groupId: values.requestedGroup ?? groupId,
    senderId: stateSigner.participantId,
    recipientId: values.recipientId ?? localId,
    media: values.media ?? 'voice',
    active: values.active ?? true,
  }, stateSigner) as SignedMediaStateEnvelope;
  const deliver = async (transportPeerId: string, envelope: unknown) => {
    const receive = receiveSignal;
    assert.ok(receive);
    receive(transportPeerId, envelope);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  try {
    await mesh.sendMediaState(peerId, 'screen', false);
    const outbound = sent[0]?.envelope;
    assert.ok(outbound?.kind === 'media-state');
    assert.equal(outbound.recipientId, peerId);
    assert.equal(await verifyProtocolEnvelope(outbound, verifier, localIdentity.publicKey), true);

    const valid = await signState(peerSigner);
    await deliver(peerId, valid);
    await deliver('transport-spoof', valid);
    await deliver(peerId, await signState(peerSigner, { media: 'screen', active: false }));
    const tampered = { ...valid, active: false };
    await deliver(peerId, tampered);
    await deliver(peerId, await signState(peerSigner, { requestedGroup: 'another-group' }));
    await deliver(peerId, await signState(peerSigner, { recipientId: 'other-device' }));
    await deliver('outsider', await signState(outsiderSigner));

    assert.deepEqual(mediaStates, [
      { peerId, media: 'voice', active: true },
      { peerId, media: 'screen', active: false },
    ]);
  } finally {
    mesh.close();
  }
});
