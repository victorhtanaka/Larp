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
  let authGate: Promise<void> | undefined;
  let removeGate: Promise<void> | undefined;
  let removeStarted: (() => void) | undefined;
  let authError: Error | undefined;
  let subscribeError: Error | undefined;
  const activeChannels = new Map<string, RealtimeChannel>();
  const channelTopics = new Map<RealtimeChannel, string>();

  const client = {
    realtime: { setAuth: async (token: string) => {
      authTokens.push(token);
      await authGate;
      if (authError) throw authError;
    } },
    channel: (topic: string, options: unknown) => {
      topics.push({ topic, options });
      const existing = activeChannels.get(topic);
      if (existing) return existing;
      let subscribed = false;
      const channel: RealtimeChannel = {
        on(type: string, filter: unknown, callback: unknown) {
          if (subscribed) throw new Error('Cannot add handlers after subscribe');
          handlers.push({ type, filter, callback: callback as (event: unknown) => void });
          return channel;
        },
        subscribe(callback: unknown) {
          if (subscribeError) throw subscribeError;
          if (subscribed) throw new Error('Channel already subscribed');
          subscribed = true;
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
      } as unknown as RealtimeChannel;
      activeChannels.set(topic, channel);
      channelTopics.set(channel, topic);
      return channel;
    },
    removeChannel: async (value: RealtimeChannel) => {
      removeStarted?.();
      removed.push(value);
      await removeGate;
      if (removeResult === 'ok') activeChannels.delete(channelTopics.get(value)!);
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
    setAuthGate(value?: Promise<void>) { authGate = value; },
    setRemoveGate(value?: Promise<void>) { removeGate = value; },
    onRemoveStarted(value: () => void) { removeStarted = value; },
    setAuthError(value?: Error) { authError = value; },
    setSubscribeError(value?: Error) { subscribeError = value; },
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
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
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
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
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

test('multiplexes a reused topic with scoped events and closes only the last subscriber', async () => {
  const harness = createHarness();
  const second = { ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2', epoch: 9, accessToken: 'access-2' } };
  await Promise.all([harness.transport.handle(openCall), harness.transport.handle(second)]);
  assert.equal(harness.topics.length, 1);
  assert.equal(harness.subscribeCallbacks.length, 1);
  assert.equal(harness.handlers.length, 4);
  assert.deepEqual(harness.authTokens, ['access-1', 'access-2']);
  assert.equal(await harness.currentAccessToken(), 'access-2');

  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  harness.handlers[0]!.callback({ payload: { envelope: 'signal' } });
  harness.handlers[1]!.callback(undefined);
  harness.handlers[2]!.callback(undefined);
  assert.deepEqual(harness.events.map(({ subscriptionId, epoch, kind }) => [subscriptionId, epoch, kind]), [
    ['sub-1', 7, 'presence'], ['sub-2', 9, 'presence'],
    ['sub-1', 7, 'signal'], ['sub-2', 9, 'signal'],
    ['sub-1', 7, 'presence'], ['sub-2', 9, 'presence'],
    ['sub-1', 7, 'members'], ['sub-2', 9, 'members'],
  ]);

  const close = { version: 1 as const, kind: 'cloud' as const, op: 'close-channel' as const, payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } };
  await harness.transport.handle({ ...close, payload: { ...close.payload, epoch: 8 } });
  await harness.transport.handle(close);
  assert.equal(harness.removed.length, 0);
  harness.events.length = 0;
  harness.handlers[3]!.callback(undefined);
  assert.deepEqual(harness.events.map(({ subscriptionId, epoch, kind }) => [subscriptionId, epoch, kind]), [['sub-2', 9, 'members']]);
  await harness.transport.handle({ ...close, payload: { ...close.payload, subscriptionId: 'sub-2', epoch: 9 } });
  assert.equal(harness.removed.length, 1);
  harness.handlers[0]!.callback({ payload: {} });
  assert.equal(harness.events.length, 1);
});

test('reports current status to late subscribers and preserves other subscribers on authentication failure', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  harness.setPresenceState({ user: [{ status: 'online' }] });
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  const second = { ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2', epoch: 10, accessToken: 'bad-token' } };
  harness.setAuthError(new Error('auth failed'));
  await assert.rejects(harness.transport.handle(second), /auth failed/u);
  assert.equal(await harness.currentAccessToken(), 'access-1');
  harness.setAuthError();
  await harness.transport.handle(second);
  assert.deepEqual(harness.events.at(-1), {
    subscriptionId: 'sub-2', epoch: 10, kind: 'presence',
    payload: { presence: { user: [{ status: 'online' }] }, ready: true },
  });
  await assert.rejects(harness.transport.handle({ ...second, payload: { ...second.payload, subscriptionId: 'sub-3', userId: 'other-user' } }), /different user/u);
  harness.subscribeCallbacks[0]!('CHANNEL_ERROR', new Error('offline'));
  await harness.transport.handle({ ...second, payload: { ...second.payload, subscriptionId: 'sub-3', epoch: 11 } });
  assert.deepEqual(harness.events.at(-1), {
    subscriptionId: 'sub-3', epoch: 11, kind: 'error', payload: { message: 'offline' },
  });
});

test('serializes open and final close so a new subscriber never attaches to a closing channel', async () => {
  const harness = createHarness();
  const auth = Promise.withResolvers<void>();
  harness.setAuthGate(auth.promise);
  const first = harness.transport.handle(openCall);
  const second = harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2', epoch: 8 } });
  auth.resolve();
  await Promise.all([first, second]);
  assert.equal(harness.topics.length, 1);
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-2', epoch: 8, groupId: 'group-1' } });
  const removal = Promise.withResolvers<void>();
  const removalStarted = Promise.withResolvers<void>();
  harness.onRemoveStarted(removalStarted.resolve);
  harness.setRemoveGate(removal.promise);
  const closing = harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  await removalStarted.promise;
  const reopening = harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-3', epoch: 12 } });
  removal.resolve();
  await Promise.all([closing, reopening]);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.topics.length, 2);
  assert.equal(harness.subscribeCallbacks.length, 2);
  harness.events.length = 0;
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  assert.equal(harness.events.length, 0);
  harness.subscribeCallbacks[1]!('SUBSCRIBED');
  assert.deepEqual(harness.events.map(({ subscriptionId, epoch }) => [subscriptionId, epoch]), [['sub-3', 12]]);
});

test('waits for subscription before tracking and cancels pending tracks on errors or close', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  const track = { version: 1 as const, kind: 'cloud' as const, op: 'track-presence' as const, payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1', userId: 'user-1', status: 'online' as const } };
  const pending = harness.transport.handle(track);
  assert.deepEqual(harness.tracked, []);
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  await pending;
  assert.deepEqual(harness.tracked, [{ userId: 'user-1', status: 'online' }]);

  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  await harness.transport.handle(openCall);
  const failing = assert.rejects(harness.transport.handle(track), /offline/u);
  harness.subscribeCallbacks[1]!('CHANNEL_ERROR', new Error('offline'));
  await failing;
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  await harness.transport.handle(openCall);
  const cancelled = assert.rejects(harness.transport.handle(track), /unavailable/u);
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  await cancelled;
  assert.equal(harness.tracked.length, 1);
});

test('disposal removes each group once and retains every subscriber on a failed removal', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  await harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2', epoch: 8 } });
  await harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-3', groupId: 'group-2' } });
  harness.setRemoveResult('error');
  await assert.rejects(harness.transport.handle({ version: 1, kind: 'cloud', op: 'dispose', payload: {} }), /confirm closing/u);
  assert.equal(harness.removed.length, 2);
  harness.events.length = 0;
  harness.handlers[2]!.callback(undefined);
  assert.deepEqual(harness.events.map(({ subscriptionId }) => subscriptionId), ['sub-1', 'sub-2']);
  harness.setRemoveResult('ok');
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'dispose', payload: {} });
  assert.equal(harness.removed.length, 4);
});

test('recovers from synchronous channel setup failure and retries failed cleanup', async () => {
  const harness = createHarness();
  harness.setSubscribeError(new Error('setup failed'));
  harness.setRemoveResult('error');
  await assert.rejects(harness.transport.handle(openCall), /setup failed/u);
  await assert.rejects(harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2' } }), /setup failed/u);
  harness.setRemoveResult('ok');
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  harness.setSubscribeError();
  await harness.transport.handle(openCall);
  assert.equal(harness.topics.length, 2);
  assert.equal(harness.subscribeCallbacks.length, 1);
});

test('rejects concurrent reuse of the same subscription identifier', async () => {
  const harness = createHarness();
  const auth = Promise.withResolvers<void>();
  harness.setAuthGate(auth.promise);
  const first = harness.transport.handle(openCall);
  const duplicate = assert.rejects(harness.transport.handle(openCall), /already active/u);
  auth.resolve();
  await first;
  await duplicate;
  assert.equal(harness.topics.length, 1);
});

test('closing one waiting subscriber does not cancel the other subscriber’s presence', async () => {
  const harness = createHarness();
  await harness.transport.handle(openCall);
  await harness.transport.handle({ ...openCall, payload: { ...openCall.payload, subscriptionId: 'sub-2', epoch: 8 } });
  const track = { version: 1 as const, kind: 'cloud' as const, op: 'track-presence' as const, payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1', userId: 'user-1', status: 'online' as const } };
  const cancelled = assert.rejects(harness.transport.handle(track), /unavailable/u);
  const other = harness.transport.handle({ ...track, payload: { ...track.payload, subscriptionId: 'sub-2', epoch: 8 } });
  await harness.transport.handle({ version: 1, kind: 'cloud', op: 'close-channel', payload: { subscriptionId: 'sub-1', epoch: 7, groupId: 'group-1' } });
  await cancelled;
  assert.equal(harness.removed.length, 0);
  assert.equal(harness.tracked.length, 0);
  harness.subscribeCallbacks[0]!('SUBSCRIBED');
  await other;
  assert.deepEqual(harness.tracked, [{ userId: 'user-1', status: 'online' }]);
});
