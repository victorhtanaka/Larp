import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeCore, NativeCoreError, type NativeCoreClient } from '../src/main/native-core';
import { projectEnvelope } from '../src/main/envelope-projection';
import { signProtocolEnvelope } from '../src/shared/webrtc-protocol';
import type { IdentitySignature } from '../src/shared/cloud-contracts';
import type { HostCall, JsonResponse } from '../src/shared/native-core-contracts';

function successful<T>(value: T): JsonResponse<T> {
  return { version: 1, ok: true, value };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPublicIdentity(value: unknown): { algorithm: 'Ed25519'; publicKey: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || value.algorithm !== 'Ed25519' || typeof value.publicKey !== 'string') {
    throw new TypeError('The native addon returned an invalid public identity.');
  }
  return { algorithm: 'Ed25519', publicKey: value.publicKey };
}

function readIdentitySignature(value: unknown): IdentitySignature {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || value.algorithm !== 'Ed25519' || typeof value.signature !== 'string') {
    throw new TypeError('The native addon returned an invalid identity signature.');
  }
  return { algorithm: 'Ed25519', signature: value.signature };
}


// Test-only passthrough in an isolated temp root; Electron smoke covers real safeStorage.
function createEphemeralHostCall(): (requestJson: string) => Promise<string> {
  return async (requestJson) => {
    const call = JSON.parse(requestJson) as HostCall;
    let response: JsonResponse;
    if (call.kind === 'secrets') {
      if (call.op === 'available') response = successful(true);
      else if (call.op === 'encrypt') response = successful({ ciphertextBase64: call.payload.plaintextBase64 });
      else response = successful({ plaintextBase64: call.payload.ciphertextBase64, shouldReEncrypt: false });
    } else if (call.kind === 'cloud' && call.op === 'dispose') {
      response = successful({ data: null, error: null });
    } else {
      response = { version: 1, ok: false, error: { code: 'TEST_HOST_OPERATION', message: 'Unexpected isolated test host operation.' } };
    }
    return JSON.stringify(response);
  };
}

test('real Node addon signs and verifies owned UTF-8 payloads and closes idempotently', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-native-node-'));
  let core: Awaited<ReturnType<typeof createNativeCore>> | undefined;
  try {
    core = await createNativeCore(userDataPath, null, createEphemeralHostCall(), () => {});
    const identity = readPublicIdentity(await core.request({ version: 1, op: 'getPublicIdentity', payload: {} }));
    assert.equal(identity.algorithm, 'Ed25519');
    const payloadBase64 = Buffer.from('Native Node addon — café', 'utf8').toString('base64');
    const signature = readIdentitySignature(await core.request({ version: 1, op: 'signIdentityPayload', payload: { payloadBase64 } }));
    assert.equal(signature.algorithm, 'Ed25519');
    assert.equal(await core.request({
      version: 1,
      op: 'verifyIdentityPayload',
      payload: { payloadBase64, signature, publicKey: identity.publicKey },
    }), true);
    assert.equal(await core.request({
      version: 1,
      op: 'verifyIdentityPayload',
      payload: { payloadBase64: Buffer.from('altered', 'utf8').toString('base64'), signature, publicKey: identity.publicKey },
    }), false);
    await Promise.all([core.close(), core.close()]);
    await assert.rejects(core.request({ version: 1, op: 'getPublicIdentity', payload: {} }),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'closed');
  } finally {
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});


test('real Node addon rejects unexpected native request fields', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-native-node-'));
  let core: Awaited<ReturnType<typeof createNativeCore>> | undefined;
  try {
    core = await createNativeCore(userDataPath, null, createEphemeralHostCall(), () => {});
    const malformedRequest = {
      version: 1,
      op: 'getPublicIdentity',
      payload: { extra: true },
    } as unknown as Parameters<typeof core.request>[0];
    await assert.rejects(core.request(malformedRequest),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-request');
  } finally {
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
test('real Node addon enforces request backpressure while secret host work is stalled', { timeout: 10_000 }, async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-native-node-'));
  let core: Awaited<ReturnType<typeof createNativeCore>> | undefined;
  const { promise: hostGate, resolve: releaseHost } = Promise.withResolvers<void>();
  const { promise: hostStarted, resolve: notifyHostStarted } = Promise.withResolvers<void>();
  const { promise: testAborted, reject: rejectTestAbort } = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => rejectTestAbort(new Error('Backpressure test timed out.')), { once: true });
  const respond = createEphemeralHostCall();
  let blockAvailability = true;
  let pending: Promise<unknown>[] = [];
  const hostCall = async (requestJson: string): Promise<string> => {
    const call = JSON.parse(requestJson) as HostCall;
    if (blockAvailability && call.kind === 'secrets' && call.op === 'available') {
      blockAvailability = false;
      notifyHostStarted();
      await hostGate;
    }
    return respond(requestJson);
  };
  try {
    core = await createNativeCore(userDataPath, null, hostCall, () => {});
    pending = Array.from({ length: 96 }, () => core!.request({
      version: 1, op: 'getPublicIdentity', payload: {},
    }));
    await Promise.race([hostStarted, testAborted]);

    const { promise: overflowObserved, resolve: overflowResolve, reject: overflowReject } = Promise.withResolvers<void>();
    let unsettled = pending.length;
    for (const request of pending) {
      void request.then(
        () => {
          unsettled -= 1;
          if (unsettled === 0) overflowReject(new Error('All requests settled without backpressure.'));
        },
        (error: unknown) => {
          unsettled -= 1;
          if (error instanceof NativeCoreError && error.code === 'queue-full') overflowResolve();
          else if (unsettled === 0) overflowReject(error);
        },
      );
    }
    await Promise.race([overflowObserved, testAborted]);

    releaseHost();
    const settled = await Promise.allSettled(pending);
    const queued = settled.filter((result) => result.status === 'rejected'
      && result.reason instanceof NativeCoreError && result.reason.code === 'queue-full');
    const completed = settled.filter((result) => result.status === 'fulfilled');
    assert.ok(queued.length > 0);
    assert.ok(completed.length > 0);
    assert.equal(queued.length + completed.length, pending.length);
  } finally {
    releaseHost();
    await Promise.allSettled(pending);
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('real Node addon permits host-call reentrancy without blocking storage', { timeout: 10_000 }, async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-native-node-'));
  let core: Awaited<ReturnType<typeof createNativeCore>> | undefined;
  let reentrantRequest: Promise<unknown> | undefined;
  let reentrantResult: unknown;
  let entered = false;
  const { promise: testAborted, reject: rejectTestAbort } = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => rejectTestAbort(new Error('Reentrancy test timed out.')), { once: true });
  const respond = createEphemeralHostCall();
  const hostCall = async (requestJson: string): Promise<string> => {
    const call = JSON.parse(requestJson) as HostCall;
    if (!entered && call.kind === 'secrets' && call.op === 'available') {
      entered = true;
      reentrantRequest = core!.request({ version: 1, op: 'getCachedCloudGroups', payload: {} });
      reentrantResult = await Promise.race([reentrantRequest, testAborted]);
    }
    return respond(requestJson);
  };
  try {
    core = await createNativeCore(userDataPath, null, hostCall, () => {});
    const identity = readPublicIdentity(await Promise.race([
      core.request({ version: 1, op: 'getPublicIdentity', payload: {} }),
      testAborted,
    ]));
    if (reentrantRequest) await reentrantRequest;
    assert.equal(entered, true);
    assert.deepEqual(reentrantResult, []);
    assert.equal(identity.algorithm, 'Ed25519');
  } finally {
    if (core) await core.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('native membership snapshots, remote acknowledgements and realtime authorization stay consistent', { timeout: 20_000 }, async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'larp-native-members-'));
  const groupId = '00000000-0000-0000-0000-000000000001';
  const localId = '00000000-0000-0000-0000-000000000002';
  const peerId = '00000000-0000-0000-0000-000000000003';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const peerKeys = generateKeyPairSync('ed25519');
  const peerPublic = peerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let localPublic = '';
  let includePeer = false;
  let rejectMembers = false;
  let releaseMembers: (() => void) | undefined;
  let memberRequestStarted: (() => void) | undefined;
  const server = createServer((request, response) => {
    request.resume();
    const send = (value: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const url = request.url ?? '';
    if (url === '/auth/v1/signup') {
      send({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, user: { id: localId } });
    } else if (url === '/rest/v1/rpc/register_identity') {
      send(null);
    } else if (url === '/rest/v1/rpc/list_my_groups') {
      send([{ id: groupId, name: 'Room', created_at: timestamp, member_count: includePeer ? 2 : 1, role: 'owner' }]);
    } else if (url === '/rest/v1/rpc/list_group_members') {
      if (rejectMembers) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const rows = [{ user_id: localId, public_key: localPublic, joined_at: timestamp, role: 'owner' }];
      if (includePeer) rows.push({ user_id: peerId, public_key: peerPublic, joined_at: timestamp, role: 'member' });
      if (memberRequestStarted) {
        const started = memberRequestStarted;
        memberRequestStarted = undefined;
        const gate = Promise.withResolvers<void>();
        releaseMembers = gate.resolve;
        started();
        void gate.promise.then(() => send(rows));
      } else send(rows);
    } else if (url.startsWith('/rest/v1/larp_user_profiles?')) {
      send([]);
    } else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let core: NativeCoreClient | undefined;
  const events: Array<{ subscriptionId: string; epoch: number; kind: string; payload: unknown }> = [];
  const secrets = createEphemeralHostCall();
  try {
    core = await createNativeCore(userDataPath, { url: `http://127.0.0.1:${address.port}`, anonKey: 'sb_publishable_test' }, async (raw) => {
      const call = JSON.parse(raw) as HostCall;
      if (call.kind === 'secrets') return secrets(raw);
      if (call.kind === 'codec') return JSON.stringify(successful(projectEnvelope(call.payload.envelopeJson)));
      if (call.op === 'open-channel' && call.payload.subscriptionId === 'members') includePeer = true;
      return JSON.stringify(successful(call.op === 'track-presence' ? 'ok' : null));
    }, (raw) => events.push(JSON.parse(raw)));
    localPublic = readPublicIdentity(await core.request({ version: 1, op: 'getPublicIdentity', payload: {} })).publicKey;
    await core.request({ version: 1, op: 'refreshCloud', payload: {} });
    await core.request({ version: 1, op: 'subscribeCloudMembers', payload: { groupId, subscriptionId: 'members', epoch: 7 } });
    assert.deepEqual(events.find((event) => event.subscriptionId === 'members'), {
      subscriptionId: 'members', epoch: 7, kind: 'members',
      payload: [
        { userId: localId, publicKey: localPublic, joinedAt: timestamp, role: 'owner', profile: null },
        { userId: peerId, publicKey: peerPublic, joinedAt: timestamp, role: 'member', profile: null },
      ],
    });
    await core.request({ version: 1, op: 'subscribeCloudPresence', payload: { groupId, subscriptionId: 'presence', epoch: 8 } });
    await core.request({ version: 1, op: 'subscribeSignals', payload: { groupId, subscriptionId: 'signals', epoch: 9 } });

    const localSigner = {
      participantId: localId,
      sign: async (bytes: Uint8Array) => readIdentitySignature(await core!.request({
        version: 1, op: 'signIdentityPayload', payload: { payloadBase64: Buffer.from(bytes).toString('base64') },
      })),
    };
    const peerSigner = {
      participantId: peerId,
      sign: async (bytes: Uint8Array): Promise<IdentitySignature> => ({
        algorithm: 'Ed25519', signature: sign(null, bytes, peerKeys.privateKey).toString('base64'),
      }),
    };
    const message = await signProtocolEnvelope({
      version: 1, kind: 'chat', groupId, senderId: localId, messageId: 'message-1', sequence: 1,
      content: 'hello', createdAt: timestamp,
    }, localSigner);
    await core.request({ version: 1, op: 'persistOutgoingEnvelope', payload: { message } });
    const acknowledgement = await signProtocolEnvelope({
      version: 1, kind: 'ack', groupId, senderId: peerId, messageId: 'message-1', sequence: 1,
    }, peerSigner);
    await assert.rejects(core.request({
      version: 1, op: 'persistMessageAcknowledgement',
      payload: { acknowledgement: { ...acknowledgement, signature: message.signature } },
    }), (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
    await core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement } });
    await core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement } });
    const missing = await signProtocolEnvelope({
      version: 1, kind: 'ack', groupId, senderId: peerId, messageId: 'missing', sequence: 2,
    }, peerSigner);
    await assert.rejects(core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement: missing } }),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'conflict');

    const signal = await signProtocolEnvelope({
      version: 1, kind: 'connect-request', groupId, senderId: peerId, recipientId: localId,
    }, peerSigner);
    const signalEvent = JSON.stringify({ kind: 'signal', payload: { envelope: signal } });
    const presenceEvent = JSON.stringify({ kind: 'presence', payload: {
      presence: { [peerId]: [{ userId: peerId, status: 'online' }] }, ready: true,
    } });
    await core.ingestCloudEvent('signals', 9, signalEvent);
    await core.ingestCloudEvent('presence', 8, presenceEvent);
    assert.deepEqual(events.at(-1)?.payload, { presence: { [peerId]: 'online' }, ready: true });

    includePeer = false;
    const started = Promise.withResolvers<void>();
    memberRequestStarted = started.resolve;
    const removal = core.ingestCloudEvent('members', 7, JSON.stringify({ kind: 'members', payload: null }));
    await started.promise;
    const pendingPresence = core.ingestCloudEvent('presence', 8, presenceEvent);
    releaseMembers!();
    await removal;
    await pendingPresence;
    const removalSnapshot = events.findLast((event) => event.subscriptionId === 'members' && event.kind === 'members');
    assert.deepEqual((removalSnapshot?.payload as Array<{ userId: string }>).map((member) => member.userId), [localId]);
    const cachedAfterRemoval = await core.request({ version: 1, op: 'getCachedCloudMembers', payload: { groupId } }) as Array<{ userId: string }>;
    assert.deepEqual(cachedAfterRemoval.map((member) => member.userId), [localId]);
    assert.deepEqual(events.at(-1)?.payload, { presence: {}, ready: true });
    await assert.rejects(core.ingestCloudEvent('signals', 9, signalEvent),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
    await assert.rejects(core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement } }),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
    includePeer = true;
    await core.ingestCloudEvent('members', 7, JSON.stringify({ kind: 'members', payload: null }));
    await core.ingestCloudEvent('signals', 9, signalEvent);
    await core.ingestCloudEvent('presence', 8, presenceEvent);
    assert.deepEqual(events.at(-1)?.payload, { presence: { [peerId]: 'online' }, ready: true });
    rejectMembers = true;
    await assert.rejects(core.ingestCloudEvent('members', 7, JSON.stringify({ kind: 'members', payload: null })));
    await assert.rejects(core.ingestCloudEvent('signals', 9, signalEvent),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
    await assert.rejects(core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement } }),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
    assert.equal((await core.request({ version: 1, op: 'getCachedCloudMembers', payload: { groupId } }) as unknown[]).length, 2);
    rejectMembers = false;
    await core.ingestCloudEvent('members', 7, JSON.stringify({ kind: 'members', payload: null }));
    await core.ingestCloudEvent('signals', 9, signalEvent);
    await core.request({ version: 1, op: 'persistMessageAcknowledgement', payload: { acknowledgement } });
    await assert.rejects(core.ingestCloudEvent('members', 6, JSON.stringify({ kind: 'members', payload: null })),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'stale-context');
    includePeer = false;
    const staleStarted = Promise.withResolvers<void>();
    memberRequestStarted = staleStarted.resolve;
    const staleRefresh = core.ingestCloudEvent('members', 7, JSON.stringify({ kind: 'members', payload: null }));
    await staleStarted.promise;
    await core.cancelSubscription('members', 7);
    releaseMembers!();
    await assert.rejects(staleRefresh, (error: unknown) => error instanceof NativeCoreError && error.code === 'stale-context');
    await core.ingestCloudEvent('signals', 9, signalEvent);
    await core.ingestCloudEvent('presence', 8, JSON.stringify({ kind: 'members', payload: null }));
    await assert.rejects(core.ingestCloudEvent('signals', 9, signalEvent),
      (error: unknown) => error instanceof NativeCoreError && error.code === 'invalid-identity');
  } finally {
    releaseMembers?.();
    if (core) await core.close();
    server.close();
    await once(server, 'close');
    await rm(userDataPath, { recursive: true, force: true });
  }
});
