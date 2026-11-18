import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeHostCall } from '../src/main/native-host-calls';
import { createSystemCpuUsageSampler } from '../src/main/system-cpu';
import type { CpuInfo } from 'node:os';
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

function cpu(user: number, idle: number, nice = 0, sys = 0, irq = 0): CpuInfo {
  return { model: 'test', speed: 0, times: { user, nice, sys, idle, irq } };
}

test('system CPU usage aggregates all CPU time deltas, including idle and other time categories', () => {
  let sample = [cpu(100, 100), cpu(100, 100)];
  const usage = createSystemCpuUsageSampler(() => sample);
  assert.equal(usage(), null);
  sample = [cpu(110, 110, 10, 10, 10), cpu(130, 120)];
  assert.equal(usage(), 70);
  sample = [cpu(110, 120, 10, 10, 10), cpu(130, 130)];
  assert.equal(usage(), 0);
  sample = [cpu(120, 120, 10, 10, 10), cpu(140, 130)];
  assert.equal(usage(), 100);
  assert.equal(usage(), null);
});

test('system CPU usage resets or reestablishes its baseline after invalid samples and counter changes', () => {
  let sample = [cpu(10, 10)];
  let fail = false;
  const usage = createSystemCpuUsageSampler(() => {
    if (fail) throw new Error('unavailable');
    return sample;
  });
  assert.equal(usage(), null);
  fail = true;
  assert.equal(usage(), null);
  fail = false;
  sample = [cpu(20, 20)];
  assert.equal(usage(), null);
  sample = [cpu(30, 30)];
  assert.equal(usage(), 50);
  sample = [];
  assert.equal(usage(), null);
  sample = [cpu(Number.NaN, 0)];
  assert.equal(usage(), null);
  sample = [cpu(40, 40)];
  assert.equal(usage(), null);
  sample = [cpu(20, 50)];
  assert.equal(usage(), null);
  sample = [cpu(30, 60)];
  assert.equal(usage(), 50);
  sample = [cpu(40, 70), cpu(0, 0)];
  assert.equal(usage(), null);
  sample = [cpu(50, 80), cpu(10, 10)];
  assert.equal(usage(), 50);
});
