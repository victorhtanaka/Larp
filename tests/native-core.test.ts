import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeCore, NativeCoreError } from '../src/main/native-core';
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
