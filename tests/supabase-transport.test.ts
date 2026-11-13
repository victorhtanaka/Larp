import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseTransport } from '../src/main/supabase-transport';

type TestHandler = { type: string; filter: unknown; callback: (event: unknown) => void };
type PresenceCallback = (status: string, error?: Error) => void;
type TestClient = Pick<SupabaseClient, 'realtime' | 'channel' | 'removeChannel'>;

function createHarness() {
  const handlers: TestHandler[] = [];
  const subscribeCallbacks: PresenceCallback[] = [];
  const authTokens: string[] = [];
  const topics: Array<{ topic: string; options: unknown }> = [];
  const sent: unknown[] = [];
  const tracked: unknown[] = [];
  const removed: RealtimeChannel[] = [];
  const events: Array<Record<string, unknown>> = [];
  let presenceState: Record<string, unknown> = {};
  let accessTokenProvider: (() => Promise<string>) | undefined;
  let sendResult: 'ok' | 'timed out' | 'error' = 'ok';
  let trackResult: 'ok' | 'timed out' | 'error' = 'ok';
  let removeResult: 'ok' | 'timed out' | 'error' = 'ok';

  const channel = {
    on(type: string, filter: unknown, callback: unknown) {
      handlers.push({ type, filter, callback: callback as (event: unknown) => void });
      return channel;
    },
    subscribe(callback: unknown) {
      subscribeCallbacks.push(callback as PresenceCallback);
      return channel;
    },
    send: async (message: unknown) => {
      sent.push(message);
      return sendResult;
    },
    track: async (payload: unknown) => {
      tracked.push(payload);
      return trackResult;
    },
    presenceState: () => presenceState,
  };
  const client = {
    realtime: { setAuth: async (token: string) => { authTokens.push(token); } },
    channel: (topic: string, options: unknown) => {
      topics.push({ topic, options });
      return channel as unknown as RealtimeChannel;
    },
    removeChannel: async (value: RealtimeChannel) => {
      removed.push(value);
      return removeResult;
    },
  };
  const clientFactory = (
    _url: string,
    _anonKey: string,
    options: { accessToken: () => Promise<string> },
  ): TestClient => {
    accessTokenProvider = options.accessToken;
    return client as unknown as TestClient;
  };
  const transport = createSupabaseTransport('https://supabase.example', 'anon-key', async (id, epoch, json) => {
    const event = JSON.parse(json) as Record<string, unknown>;
    assert.equal(event.subscriptionId, id);
    assert.equal(event.epoch, epoch);
    events.push(event);
  }, clientFactory);

  return {
    transport, handlers, subscribeCallbacks, authTokens, topics, sent, tracked, removed, events,
    async currentAccessToken() {
      assert.ok(accessTokenProvider);
      return accessTokenProvider();
    },
    setPresenceState(value: Record<string, unknown>) { presenceState = value; },
    setSendResult(value: 'ok' | 'timed out' | 'error') { sendResult = value; },
    setTrackResult(value: 'ok' | 'timed out' | 'error') { trackResult = value; },
    setRemoveResult(value: 'ok' | 'timed out' | 'error') { removeResult = value; },
  };
}

const openCall = {
  version: 1 as const,
  kind: 'cloud' as const,
  op: 'open-channel' as const,
  payload: {
    subscriptionId: 'sub-1',
    epoch: 7,
    groupId: 'group-1',
    userId: 'user-1',
    accessToken: 'access-1',
  },
};

test('accepts native access tokens without Supabase Auth storage', async () => {
  const harness = createHarness();
  const result = await harness.transport.handle({
    version: 1,
    kind: 'cloud',
    op: 'set-auth',
    payload: { accessToken: 'native-access-token' },
  });

  assert.deepEqual(result, { version: 1, ok: true, value: { data: null, error: null } });
  assert.deepEqual(harness.authTokens, ['native-access-token']);
  assert.equal(await harness.currentAccessToken(), 'native-access-token');
});

test('opens an authenticated private channel and forwards scoped Realtime events', async () => {
  const harness = createHarness();
  const result = await harness.transport.handle(openCall);

  assert.deepEqual(result, { version: 1, ok: true, value: { data: null, error: null } });
  assert.deepEqual(harness.authTokens, ['access-1']);
  assert.deepEqual(harness.topics, [{
    topic: 'group:group-1',
    options: { config: { private: true, broadcast: { ack: true, self: false }, presence: { key: 'user-1' } } },
  }]);
  assert.deepEqual(harness.handlers.map(({ type, filter }) => ({ type, filter })), [
    { type: 'broadcast', filter: { event: 'signal' } },
    { type: 'presence', filter: { event: 'sync' } },
    { type: 'postgres_changes', filter: { event: '*', schema: 'public', table: 'larp_group_members', filter: 'group_id=eq.group-1' } },
    { type: 'postgres_changes', filter: { event: '*', schema: 'public', table: 'larp_user_profiles' } },
  ]);

  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  harness.setPresenceState({ 'user-1': [{ userId: 'user-1', status: 'online' }] });
  harness.handlers[1]!.callback(undefined);
  harness.handlers[0]!.callback({ payload: { envelope: { signed: true } } });
  harness.handlers[2]!.callback(undefined);
  harness.handlers[3]!.callback(undefined);

  assert.deepEqual(harness.events.map(({ kind, payload }) => ({ kind, payload })), [
    { kind: 'presence', payload: { presence: {}, ready: true } },
    { kind: 'presence', payload: { presence: { 'user-1': [{ userId: 'user-1', status: 'online' }] }, ready: true } },
    { kind: 'signal', payload: { envelope: { signed: true } } },
    { kind: 'members', payload: null },
    { kind: 'members', payload: null },
  ]);
});

test('sends signals and tracks presence; failed close retains the channel until confirmed', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  const envelope = {
    version: 1,
    kind: 'media-state',
    groupId: 'group-1',
    senderId: 'user-1',
    recipientId: 'user-2',
    media: 'voice',
    active: true,
    signature: { algorithm: 'Ed25519', signature: 'AQ==' },
  } as const;

  const signalCall = {
    version: 1 as const,
    kind: 'cloud' as const,
    op: 'send-signal' as const,
    payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1', envelope },
  };
  assert.deepEqual(await harness.transport.handle(signalCall), { version: 1, ok: true, value: { data: 'ok', error: null } });
  assert.deepEqual(harness.sent, [{ type: 'broadcast', event: 'signal', payload: { envelope } }]);

  const presenceCall = {
    version: 1 as const,
    kind: 'cloud' as const,
    op: 'track-presence' as const,
    payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1', userId: 'user-1', status: 'online' as const },
  };
  await harness.transport.handle(presenceCall);
  assert.deepEqual(harness.tracked, [{ userId: 'user-1', status: 'online' }]);

  harness.setSendResult('timed out');
  await assert.rejects(harness.transport.handle(signalCall), /confirm sending/u);
  harness.setSendResult('ok');
  harness.setTrackResult('error');
  await assert.rejects(harness.transport.handle(presenceCall), /confirm tracking/u);
  harness.setTrackResult('ok');

  harness.setRemoveResult('error');
  await assert.rejects(harness.transport.handle({
    version: 1, kind: 'cloud', op: 'close-channel',
    payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' },
  }));
  assert.equal(harness.removed.length, 1);
  await harness.transport.handle(signalCall);

  harness.setRemoveResult('ok');
  await harness.transport.handle({
    version: 1, kind: 'cloud', op: 'close-channel',
    payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' },
  });
  await assert.rejects(harness.transport.handle(signalCall), /unavailable/u);
});

test('rejects reused or mismatched subscriptions and preserves channels after failed disposal', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  await assert.rejects(harness.transport.handle(openCall), /already active/u);
  await assert.rejects(harness.transport.handle({
    version: 1, kind: 'cloud', op: 'send-signal',
    payload: {
      subscriptionId: 'sub-1', epoch: 8, groupId: 'group-1',
      envelope: {
        version: 1, kind: 'media-state', groupId: 'group-1', senderId: 'user-1',
        recipientId: 'user-2', media: 'voice', active: true,
        signature: { algorithm: 'Ed25519', signature: 'AQ==' },
      },
    },
  }), /unavailable/u);

  harness.setRemoveResult('timed out');
  await assert.rejects(harness.transport.handle({ version: 1, kind: 'cloud', op: 'dispose', payload: {} }));
  await harness.transport.handle({
    version: 1, kind: 'cloud', op: 'track-presence',
    payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1', userId: 'user-1', status: 'away' },
  });
  harness.setRemoveResult('ok');
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'dispose', payload: {} });
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'dispose', payload: {} });
});

test('forwards subscription failures as scoped error events', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  harness.subscribeCallbacks[0]!('TIMED_OUT', new Error('offline'));
  assert.deepEqual(harness.events, [{
    subscriptionId: 'sub-1',
    epoch: 7,
    kind: 'error',
    payload: { message: 'offline' },
  }]);
});
