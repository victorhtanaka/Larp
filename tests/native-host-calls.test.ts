import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeHostCall } from '../src/main/native-host-calls';
import type { HostCall, JsonResponse } from '../src/shared/native-core-contracts';

function parseResponse(raw: string): JsonResponse {
  return JSON.parse(raw) as JsonResponse;
}

test('host-call router dispatches only the typed secret and Realtime adapters', async () => {
  const calls: HostCall[] = [];
  const hostCall = createNativeHostCall({
    secrets: async (call) => {
      calls.push(call);
      return { version: 1, ok: true, value: true };
    },
    cloud: () => ({
      async handle(call) {
        calls.push(call);
        return { version: 1, ok: true, value: null };
      },
    }),
  });

  const secret = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'secrets', op: 'available', payload: {} })));
  const cloud = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'cloud', op: 'set-auth', payload: { accessToken: 'jwt' } })));
  const opened = parseResponse(await hostCall(JSON.stringify({
    version: 1, kind: 'cloud', op: 'open-channel',
    payload: { subscriptionId: 'sub', epoch: 1, groupId: 'group', userId: 'user', accessToken: 'jwt' },
  })));
  assert.deepEqual(secret, { version: 1, ok: true, value: true });
  assert.deepEqual(cloud, { version: 1, ok: true, value: null });
  assert.deepEqual(opened, { version: 1, ok: true, value: null });
  assert.deepEqual(calls.map(({ kind, op }) => [kind, op]), [['secrets', 'available'], ['cloud', 'set-auth'], ['cloud', 'open-channel']]);
});

test('host-call router rejects removed cloud operations and malformed channel credentials', async () => {
  let dispatchCount = 0;
  const hostCall = createNativeHostCall({
    secrets: async () => { dispatchCount += 1; return { version: 1, ok: true, value: true }; },
    cloud: () => ({ async handle() { dispatchCount += 1; return { version: 1, ok: true, value: null }; } }),
  });

  const removed = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'cloud', op: 'get-session', payload: {} })));
  const invalid = parseResponse(await hostCall(JSON.stringify({
    version: 1, kind: 'cloud', op: 'open-channel',
    payload: { subscriptionId: 'sub', epoch: 1, groupId: 'group', userId: 'user', accessToken: '' },
  })));
  assert.equal(removed.ok, false);
  assert.equal(invalid.ok, false);
  assert.equal(dispatchCount, 0);
});

test('host-call router rejects unknown operations and extra payload fields', async () => {
  let dispatchCount = 0;
  const hostCall = createNativeHostCall({
    secrets: async () => { dispatchCount += 1; return { version: 1, ok: true, value: true }; },
    cloud: () => ({ async handle() { dispatchCount += 1; return { version: 1, ok: true, value: null }; } }),
  });

  const unknown = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'cloud', op: 'fetch-anything', payload: {} })));
  const extra = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'secrets', op: 'available', payload: { extra: true } })));
  assert.equal(unknown.ok, false);
  assert.equal(extra.ok, false);
  assert.equal(dispatchCount, 0);
});

test('host-call router returns typed errors for missing transport but disposal is a no-op', async () => {
  const hostCall = createNativeHostCall({
    secrets: async () => ({ version: 1, ok: true, value: true }),
    cloud: () => undefined,
  });
  const response = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'cloud', op: 'set-auth', payload: { accessToken: 'jwt' } })));
  const disposed = parseResponse(await hostCall(JSON.stringify({ version: 1, kind: 'cloud', op: 'dispose', payload: {} })));
  assert.deepEqual(response, {
    version: 1,
    ok: false,
    error: { code: 'CLOUD_NOT_CONFIGURED', message: 'Supabase transport is not configured.' },
  });
  assert.deepEqual(disposed, { version: 1, ok: true, value: { data: null, error: null } });
});
