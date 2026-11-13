import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  MAX_CHAT_CONTENT_BYTES,
  MAX_SDP_BYTES,
  WEBRTC_PROTOCOL_VERSION,
  serializeStoredEnvelope,
  signProtocolEnvelope,
  validateProtocolEnvelope,
  verifyProtocolEnvelope,
  type IdentitySigner,
  type IdentityVerifier,
  type SignedAckEnvelope,
  type SignedChatEnvelope,
  type SignedProtocolEnvelope,
} from '../src/shared/webrtc-protocol';
import { MessageSynchronizer, type IncomingMessageResult, type LocalMessageStore } from '../src/renderer/rtc/message-sync';

const groupId = 'audit-group';
const otherGroupId = 'other-audit-group';
const localId = 'audit-local';
const peerId = 'audit-peer';
const otherPeerId = 'audit-other-peer';

type Identity = { readonly publicKey: string; readonly signer: IdentitySigner };
function createIdentity(participantId: string): Identity {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signer: {
      participantId,
      sign: async (bytes) => ({
        algorithm: 'Ed25519',
        signature: signBytes(null, Buffer.from(bytes), pair.privateKey).toString('base64'),
      }),
    },
  };
}

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

async function chat(signer: IdentitySigner, sequence: number, values: Partial<{
  groupId: string; messageId: string; content: string; createdAt: string;
}> = {}): Promise<SignedChatEnvelope> {
  return await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'chat',
    groupId: values.groupId ?? groupId,
    senderId: signer.participantId,
    messageId: values.messageId ?? `${signer.participantId}-message-${sequence}`,
    sequence,
    content: values.content ?? `fixture-${sequence}`,
    createdAt: values.createdAt ?? '2026-01-01T00:00:00.000Z',
  }, signer) as SignedChatEnvelope;
}

interface MemoryMessageRow { message: SignedChatEnvelope; envelopeJson: string }
interface MemoryMessageState {
  messagesById: Map<string, MemoryMessageRow>;
  messagesBySequence: Map<string, MemoryMessageRow>;
  acknowledgements: Map<string, SignedAckEnvelope>;
}

function createMemoryMessageState(): MemoryMessageState {
  return { messagesById: new Map(), messagesBySequence: new Map(), acknowledgements: new Map() };
}

function messageSequenceKey(groupId: string, authorId: string, sequence: number): string {
  return JSON.stringify([groupId, authorId, sequence]);
}

function createMemoryMessageStore(state: MemoryMessageState): LocalMessageStore {
  const persistChat = (message: SignedChatEnvelope): IncomingMessageResult => {
    const envelopeJson = serializeStoredEnvelope(message, 'chat');
    const existingById = state.messagesById.get(message.messageId);
    const sequenceKey = messageSequenceKey(message.groupId, message.senderId, message.sequence);
    const existingBySequence = state.messagesBySequence.get(sequenceKey);
    if (existingById
      && existingById.message.groupId === message.groupId
      && existingById.message.senderId === message.senderId
      && existingById.message.sequence === message.sequence
      && existingById.envelopeJson === envelopeJson) return 'duplicate';
    if (existingById || existingBySequence) return 'conflict';
    const row = { message, envelopeJson };
    state.messagesById.set(message.messageId, row);
    state.messagesBySequence.set(sequenceKey, row);
    return 'inserted';
  };
  return {
    async persistBeforeSend(message): Promise<void> {
      if (message.senderId !== localId || persistChat(message) === 'conflict') {
        throw new Error('Outbound message is not uniquely authored by the local user.');
      }
    },
    async persistVerifiedIncoming(message): Promise<IncomingMessageResult> {
      return persistChat(message);
    },
    async readMissing(groupId, authorId, afterSequence, throughSequence, limit): Promise<readonly SignedChatEnvelope[]> {
      const rows = [...state.messagesById.values()]
        .filter(({ message }) => message.groupId === groupId && message.senderId === authorId
          && message.sequence > afterSequence && message.sequence <= throughSequence)
        .sort((left, right) => left.message.sequence - right.message.sequence);
      const contiguous: SignedChatEnvelope[] = [];
      let expected = afterSequence + 1;
      for (const row of rows) {
        if (row.message.sequence !== expected || contiguous.length >= limit) break;
        contiguous.push(row.message);
        expected += 1;
      }
      return contiguous;
    },
    async persistRecipientAck(acknowledgement): Promise<void> {
      const message = state.messagesById.get(acknowledgement.messageId)?.message;
      if (!message || message.senderId !== localId || message.groupId !== acknowledgement.groupId
        || message.sequence !== acknowledgement.sequence) {
        throw new Error('Acknowledgement does not match a locally authored message.');
      }
      const key = JSON.stringify([
        acknowledgement.groupId, acknowledgement.messageId, acknowledgement.sequence, acknowledgement.senderId,
      ]);
      if (!state.acknowledgements.has(key)) state.acknowledgements.set(key, acknowledgement);
    },
    async getHighestContiguousSequence(groupId, authorId): Promise<number> {
      const sequences = [...state.messagesBySequence.values()]
        .filter(({ message }) => message.groupId === groupId && message.senderId === authorId)
        .map(({ message }) => message.sequence)
        .sort((left, right) => left - right);
      let expected = 1;
      for (const sequence of sequences) {
        if (sequence !== expected) break;
        expected += 1;
      }
      return expected - 1;
    },
  };
}

async function withStore<T>(run: (state: MemoryMessageState) => Promise<T>): Promise<T> {
  return run(createMemoryMessageState());
}

function createHarness(state: MemoryMessageState, options: { connected?: readonly string[] } = {}) {
  const store = createMemoryMessageStore(state);
  const identities = new Map([
    [localId, createIdentity(localId)],
    [peerId, createIdentity(peerId)],
    [otherPeerId, createIdentity(otherPeerId)],
  ]);
  const sent: Array<{ target: string; envelope: SignedProtocolEnvelope }> = [];
  const errors: Array<{ peerId: string; code: string }> = [];
  const acknowledgements: SignedAckEnvelope[] = [];
  const synchronizer = new MessageSynchronizer({
    groupId,
    localParticipantId: localId,
    signer: identities.get(localId)!.signer,
    verifier,
    store,
    isGroupMember: async (requestedGroup, participantId) => requestedGroup === groupId && identities.has(participantId),
    getGroupMemberIds: async () => [localId, peerId, otherPeerId],
    getMemberPublicKey: async (requestedGroup, participantId) => requestedGroup === groupId
      ? identities.get(participantId)?.publicKey
      : undefined,
    getPeerIds: () => options.connected ?? [peerId],
    sendToPeer: async (target, envelope) => { sent.push({ target, envelope }); },
    callbacks: {
      onProtocolError: (sender, code) => errors.push({ peerId: sender, code }),
      onAcknowledgement: (ack) => acknowledgements.push(ack),
    },
  });
  return { identities, sent, errors, acknowledgements, synchronizer, store };
}


test('Ed25519 covers canonical UTF-8 JSON bytes and rejects signed-field tampering', async () => {
  const peer = createIdentity(peerId);
  const contentAtUtf8Limit = '🙂'.repeat(MAX_CHAT_CONTENT_BYTES / 4);
  const envelope = await chat(peer.signer, 1, { content: contentAtUtf8Limit });
  assert.equal(new TextEncoder().encode(envelope.content).byteLength, MAX_CHAT_CONTENT_BYTES);
  assert.equal(validateProtocolEnvelope(envelope).ok, true);
  assert.equal(await verifyProtocolEnvelope(envelope, verifier, peer.publicKey), true);

  const tamperedContent = { ...envelope, content: 'forged' };
  assert.equal(await verifyProtocolEnvelope(tamperedContent, verifier, peer.publicKey), false);
  const tamperedSender = { ...envelope, senderId: otherPeerId };
  assert.equal(await verifyProtocolEnvelope(tamperedSender, verifier, peer.publicKey), false);
  assert.equal(await verifyProtocolEnvelope(envelope, verifier, createIdentity(peerId).publicKey), false);
  const signature = envelope.signature.signature;
  const alteredSignature = {
    ...envelope,
    signature: {
      ...envelope.signature,
      signature: `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
    },
  };
  assert.equal(validateProtocolEnvelope(alteredSignature).ok, true);
  assert.equal(await verifyProtocolEnvelope(alteredSignature, verifier, peer.publicKey), false);

  const reordered = Object.fromEntries(Object.entries(envelope).reverse());
  assert.equal(validateProtocolEnvelope(reordered).ok, true);
  assert.equal(await verifyProtocolEnvelope(reordered as SignedChatEnvelope, verifier, peer.publicKey), true);
  assert.equal(validateProtocolEnvelope({ ...envelope, content: `${contentAtUtf8Limit}🙂` }).ok, false);
  const quotedJson = await chat(peer.signer, 2, { content: 'quotes: \" \\\\ line\\n and e\\u0301' });
  const decodedQuotedJson = JSON.parse(JSON.stringify(quotedJson));
  assert.equal(validateProtocolEnvelope(decodedQuotedJson).ok, true);
  assert.equal(await verifyProtocolEnvelope(decodedQuotedJson, verifier, peer.publicKey), true);

  const description = await signProtocolEnvelope({
    version: WEBRTC_PROTOCOL_VERSION,
    kind: 'description',
    groupId,
    senderId: peerId,
    recipientId: localId,
    negotiationId: 'negotiation-1',
    description: { type: 'offer', sdp: 'é'.repeat(MAX_SDP_BYTES / 2) },
  }, peer.signer);
  assert.equal(validateProtocolEnvelope(description).ok, true);
  assert.equal(validateProtocolEnvelope({
    ...description,
    description: { type: 'offer', sdp: `${'é'.repeat(MAX_SDP_BYTES / 2)}é` },
  }).ok, false);
});

test('transport, group, and recipient bindings reject forged chat/ACKs while allowing signed relays', async () => {
  await withStore(async (state) => {
    const harness = createHarness(state);
    const peerMessage = await chat(harness.identities.get(peerId)!.signer, 1);
    await harness.synchronizer.receive(otherPeerId, JSON.stringify(peerMessage));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 1);
    assert.ok(harness.sent.some(({ target, envelope }) => target === peerId && envelope.kind === 'chat'));

    const wrongGroup = await chat(harness.identities.get(peerId)!.signer, 2, { groupId: otherGroupId });
    await harness.synchronizer.receive(peerId, JSON.stringify(wrongGroup));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 1);
    assert.equal(harness.errors.at(-1)?.code, 'unauthorized-sender');
    const mismatchedRecipient = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'protocol-error',
      groupId,
      senderId: peerId,
      recipientId: otherPeerId,
      code: 'invalid-signature',
      detail: 'fixture',
    }, harness.identities.get(peerId)!.signer);
    await harness.synchronizer.receive(peerId, JSON.stringify(mismatchedRecipient));
    assert.equal(harness.errors.at(-1)?.code, 'unauthorized-sender');

    const localMessage = await chat(harness.identities.get(localId)!.signer, 1);
    await harness.store.persistBeforeSend(localMessage);
    const wrongTransportAck = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'ack', groupId, senderId: otherPeerId,
      messageId: localMessage.messageId, sequence: localMessage.sequence,
    }, harness.identities.get(otherPeerId)!.signer) as SignedAckEnvelope;
    await harness.synchronizer.receive(peerId, JSON.stringify(wrongTransportAck));
    assert.equal(harness.acknowledgements.length, 0);
    assert.equal(harness.errors.at(-1)?.code, 'unauthorized-sender');
    assert.equal(state.acknowledgements.size, 0);
  });
});


test('sync batches require a pending matching range and independently verified nested messages', async () => {
  await withStore(async (state) => {
    const harness = createHarness(state);
    const unexpected = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'sync-batch', groupId, senderId: peerId, authorId: peerId,
      requestId: 'not-requested', afterSequence: 0, throughSequence: 10, messages: [], complete: true,
    }, harness.identities.get(peerId)!.signer);
    await harness.synchronizer.receive(peerId, JSON.stringify(unexpected));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 0);
    assert.equal(harness.errors.at(-1)?.code, 'malformed-envelope');

    await harness.synchronizer.synchronizePeer(peerId);
    const request = harness.sent.find(({ envelope }) => envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(request?.kind === 'sync-request');
    const spoofedResponder = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'sync-batch', groupId, senderId: otherPeerId, authorId: peerId,
      requestId: request.requestId, afterSequence: request.afterSequence, throughSequence: request.throughSequence,
      messages: [], complete: true,
    }, harness.identities.get(otherPeerId)!.signer);
    await harness.synchronizer.receive(peerId, JSON.stringify(spoofedResponder));
    assert.equal(harness.errors.at(-1)?.code, 'unauthorized-sender');
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 0);
    const genuineNested = await chat(harness.identities.get(peerId)!.signer, 1);
    const forgedNested = { ...genuineNested, content: 'nested payload altered' };
    const forgedBatch = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'sync-batch', groupId, senderId: peerId, authorId: peerId,
      requestId: request.requestId, afterSequence: request.afterSequence, throughSequence: request.throughSequence,
      messages: [forgedNested], complete: true,
    }, harness.identities.get(peerId)!.signer);
    await harness.synchronizer.receive(peerId, JSON.stringify(forgedBatch));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 0);
    assert.equal(harness.errors.at(-1)?.code, 'invalid-signature');
  });
});

test('empty non-final history batch cannot claim progress; valid sync requests honor protocol range boundaries', async () => {
  await withStore(async (state) => {
    const harness = createHarness(state);
    const edge = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'sync-request', groupId, senderId: peerId, authorId: peerId,
      requestId: 'edge-range', afterSequence: 0, throughSequence: 10_000, limit: 6,
    }, harness.identities.get(peerId)!.signer);
    assert.equal(validateProtocolEnvelope(edge).ok, true);
    await harness.synchronizer.receive(peerId, JSON.stringify({ ...edge, throughSequence: 10_001 }));
    assert.equal(harness.errors.at(-1)?.code, 'malformed-envelope');

    await harness.synchronizer.synchronizePeer(peerId);
    const request = harness.sent.find(({ envelope }) => envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(request?.kind === 'sync-request');
    const stalled = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'sync-batch', groupId, senderId: peerId, authorId: peerId,
      requestId: request.requestId, afterSequence: request.afterSequence, throughSequence: request.throughSequence,
      messages: [], complete: false,
    }, harness.identities.get(peerId)!.signer);
    await harness.synchronizer.receive(peerId, JSON.stringify(stalled));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 0);
    assert.equal(harness.errors.at(-1)?.code, 'malformed-envelope');
  });
});

test('outgoing publish stores before peer delivery and ACK requires a matching local message', async () => {
  await withStore(async (state) => {
    const local = createIdentity(localId);
    const peer = createIdentity(peerId);
    const store = createMemoryMessageStore(state);
    const events: string[] = [];
    const synchronizer = new MessageSynchronizer({
      groupId, localParticipantId: localId, signer: local.signer, verifier, store,
      isGroupMember: async (requestedGroup, id) => requestedGroup === groupId && [localId, peerId].includes(id),
      getGroupMemberIds: async () => [localId, peerId],
      getMemberPublicKey: async (requestedGroup, id) => requestedGroup === groupId
        ? new Map([[localId, local.publicKey], [peerId, peer.publicKey]]).get(id)
        : undefined,
      getPeerIds: () => [peerId],
      sendToPeer: async (_target, envelope) => {
        if (envelope.kind === 'chat') {
          assert.equal(await store.getHighestContiguousSequence(groupId, localId), envelope.sequence);
          events.push('chat-stored-before-send');
        }
      },
    });
    const published = await synchronizer.publish({ messageId: 'outgoing-one', sequence: 1, content: 'persist first' });
    assert.deepEqual(events, ['chat-stored-before-send']);

    const invalidAck = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'ack', groupId, senderId: peerId,
      messageId: 'not-a-local-message', sequence: 1,
    }, peer.signer) as SignedAckEnvelope;
    await synchronizer.receive(peerId, JSON.stringify(invalidAck));
    assert.equal(state.acknowledgements.size, 0);
    const authenticAck = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION, kind: 'ack', groupId, senderId: peerId,
      messageId: published.messageId, sequence: published.sequence,
    }, peer.signer) as SignedAckEnvelope;
    const forgedAck = { ...authenticAck, sequence: authenticAck.sequence + 1 };
    await synchronizer.receive(peerId, JSON.stringify(forgedAck));
    assert.equal(state.acknowledgements.size, 0);
    const ack = authenticAck;
    await synchronizer.receive(peerId, JSON.stringify(ack));
    await synchronizer.receive(peerId, JSON.stringify(ack));
    assert.equal(state.acknowledgements.size, 1);
    assert.deepEqual([...state.acknowledgements.values()].map(({ senderId, messageId }) => ({
      recipientId: senderId,
      messageId,
    })), [{ recipientId: peerId, messageId: published.messageId }]);
  });
});
test('complete sync batches preserve observed gaps and recover through continuous ranges', async () => {
  await withStore(async (state) => {
    const harness = createHarness(state);
    const peerSigner = harness.identities.get(peerId)!.signer;
    await harness.synchronizer.receive(peerId, JSON.stringify(await chat(peerSigner, 3)));
    const request = harness.sent.find(({ envelope }) =>
      envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(request?.kind === 'sync-request');
    assert.equal(request.afterSequence, 0);
    assert.equal(request.throughSequence, 2);

    const emptyBatch = (requestId: string) => signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'sync-batch',
      groupId,
      senderId: peerId,
      authorId: peerId,
      requestId,
      afterSequence: request.afterSequence,
      throughSequence: request.throughSequence,
      messages: [],
      complete: true,
    }, peerSigner);
    const sentBeforeResponse = harness.sent.length;
    await harness.synchronizer.receive(peerId, JSON.stringify(await emptyBatch(request.requestId)));

    const retry = harness.sent.slice(sentBeforeResponse).find(({ target, envelope }) =>
      target === peerId && envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(retry?.kind === 'sync-request');
    assert.notEqual(retry.requestId, request.requestId);
    assert.equal(retry.afterSequence, 0);
    assert.equal(retry.throughSequence, request.throughSequence);

    const sentBeforeRetryResponse = harness.sent.length;
    await harness.synchronizer.receive(peerId, JSON.stringify(await emptyBatch(retry.requestId)));
    assert.equal(harness.sent.slice(sentBeforeRetryResponse).some(({ target, envelope }) =>
      target === peerId && envelope.kind === 'sync-request' && envelope.authorId === peerId),
    false, 'repeated empty responses must not create an unbounded request loop');

    const sentBeforeResync = harness.sent.length;
    await harness.synchronizer.synchronizePeer(peerId);
    const resync = harness.sent.slice(sentBeforeResync).find(({ target, envelope }) =>
      target === peerId && envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(resync?.kind === 'sync-request');
    const sequenceOne = await chat(peerSigner, 1);
    const sentBeforePartial = harness.sent.length;
    await harness.synchronizer.receive(peerId, JSON.stringify(await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'sync-batch',
      groupId,
      senderId: peerId,
      authorId: peerId,
      requestId: resync.requestId,
      afterSequence: resync.afterSequence,
      throughSequence: resync.throughSequence,
      messages: [sequenceOne],
      complete: true,
    }, peerSigner)));

    const followup = harness.sent.slice(sentBeforePartial).find(({ target, envelope }) =>
      target === peerId && envelope.kind === 'sync-request' && envelope.authorId === peerId)?.envelope;
    assert.ok(followup?.kind === 'sync-request');
    assert.equal(followup.afterSequence, 1);
    assert.equal(followup.throughSequence, 2);
    const sequenceTwo = await chat(peerSigner, 2);
    const sentBeforeCompletion = harness.sent.length;
    await harness.synchronizer.receive(peerId, JSON.stringify(await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'sync-batch',
      groupId,
      senderId: peerId,
      authorId: peerId,
      requestId: followup.requestId,
      afterSequence: followup.afterSequence,
      throughSequence: followup.throughSequence,
      messages: [sequenceTwo],
      complete: true,
    }, peerSigner)));
    assert.equal(await harness.store.getHighestContiguousSequence(groupId, peerId), 3);
    assert.equal(harness.sent.slice(sentBeforeCompletion).some(({ target, envelope }) =>
      target === peerId && envelope.kind === 'sync-request' && envelope.authorId === peerId),
    false);
  });
});
