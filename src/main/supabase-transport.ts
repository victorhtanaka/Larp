import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { HostCall, JsonResponse } from '../shared/native-core-contracts';
type IngestCloudEvent = (subscriptionId: string, epoch: number, eventJson: string) => Promise<void>;
type RealtimeClient = Pick<SupabaseClient, 'realtime' | 'channel' | 'removeChannel'>;
type RealtimeClientFactory = (
  url: string,
  anonKey: string,
  options: { accessToken: () => Promise<string> },
) => RealtimeClient;
interface ChannelEntry {
  channel: RealtimeChannel;
  groupId: string;
  userId: string;
  subscriptions: Map<string, number>;
  status: { kind: 'presence' } | { kind: 'error'; message: string } | null;
  setupFailed: boolean;
  waiters: Set<{ id: string; resolve: () => void; reject: (error: Error) => void }>;
}
interface SubscriptionEntry { group: ChannelEntry; epoch: number }

export interface SupabaseTransport {
  handle(call: Extract<HostCall, { kind: 'cloud' }>): Promise<JsonResponse>;
}

export function createSupabaseTransport(
  url: string,
  anonKey: string,
  ingestCloudEvent: IngestCloudEvent,
  clientFactory: RealtimeClientFactory = (clientUrl, clientKey, options) =>
    createClient(clientUrl, clientKey, options),
): SupabaseTransport {
  let currentAccessToken = anonKey;
  const client = clientFactory(url, anonKey, { accessToken: async () => currentAccessToken });
  const channels = new Map<string, ChannelEntry>();
  const subscriptions = new Map<string, SubscriptionEntry>();
  let lifecycle = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(operation);
    lifecycle = result.then(() => undefined, () => undefined);
    return result;
  };
  const sendEvent = (id: string, epoch: number, kind: string, payload: unknown): void => {
    void ingestCloudEvent(id, epoch, JSON.stringify({ subscriptionId: id, epoch, kind, payload })).catch(() => undefined);
  };
  const broadcast = (entry: ChannelEntry, kind: string, payload: unknown): void => {
    for (const [id, epoch] of entry.subscriptions) sendEvent(id, epoch, kind, payload);
  };
  const channelFor = (id: string, epoch: number, groupId: string): RealtimeChannel => {
    const entry = subscriptions.get(id);
    if (!entry || entry.epoch !== epoch || entry.group.groupId !== groupId || entry.group.setupFailed) throw new Error('Cloud subscription is unavailable.');
    return entry.group.channel;
  };
  const cancelWaiters = (entry: ChannelEntry, message: string, id?: string): void => {
    for (const waiter of entry.waiters) {
      if (id === undefined || waiter.id === id) {
        entry.waiters.delete(waiter);
        waiter.reject(new Error(message));
      }
    }
  };
  const waitUntilSubscribed = (id: string, epoch: number, groupId: string): Promise<void> => {
    channelFor(id, epoch, groupId);
    const entry = subscriptions.get(id)!.group;
    if (entry.status?.kind === 'presence') return Promise.resolve();
    if (entry.status?.kind === 'error') return Promise.reject(new Error(entry.status.message));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    entry.waiters.add({ id, resolve, reject });
    return promise;
  };
  const setAccessToken = async (accessToken: string): Promise<void> => {
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new TypeError('Access token is invalid.');
    await client.realtime.setAuth(accessToken);
    currentAccessToken = accessToken;
  };

  const run = async (call: Extract<HostCall, { kind: 'cloud' }>): Promise<JsonResponse> => {
      let data: unknown;
      switch (call.op) {
        case 'set-auth': {
          await setAccessToken(call.payload.accessToken);
          data = null;
          break;
        }
        case 'open-channel': {
          const { subscriptionId, epoch, groupId, userId, accessToken } = call.payload;
          if (subscriptions.has(subscriptionId)) throw new Error('Subscription identifier is already active.');
          if (!userId) throw new TypeError('User ID is invalid.');
          const existing = channels.get(groupId);
          if (existing?.setupFailed) throw new Error('Cloud channel setup failed; close the subscription before reopening.');
          if (existing && existing.userId !== userId) throw new Error('Cloud channel belongs to a different user.');
          await setAccessToken(accessToken);
          if (existing) {
            existing.subscriptions.set(subscriptionId, epoch);
            subscriptions.set(subscriptionId, { group: existing, epoch });
            if (existing.status?.kind === 'presence') {
              sendEvent(subscriptionId, epoch, 'presence', { presence: existing.channel.presenceState(), ready: true });
            } else if (existing.status?.kind === 'error') {
              sendEvent(subscriptionId, epoch, 'error', { message: existing.status.message });
            }
            data = null;
            break;
          }
          const channel = client.channel(`group:${groupId}`, { config: { private: true, broadcast: { ack: true, self: false }, presence: { key: userId } } });
          const entry: ChannelEntry = { channel, groupId, userId, subscriptions: new Map([[subscriptionId, epoch]]), status: null, setupFailed: false, waiters: new Set() };
          channels.set(groupId, entry);
          subscriptions.set(subscriptionId, { group: entry, epoch });
          try {
            channel.on('broadcast', { event: 'signal' }, (message) => broadcast(entry, 'signal', message.payload));
            channel.on('presence', { event: 'sync' }, () => broadcast(entry, 'presence', { presence: channel.presenceState(), ready: true }));
            channel.on('postgres_changes', { event: '*', schema: 'public', table: 'larp_group_members', filter: `group_id=eq.${groupId}` }, () => {
              broadcast(entry, 'members', null);
            });
            channel.on('postgres_changes', { event: '*', schema: 'public', table: 'larp_user_profiles' }, () => {
              broadcast(entry, 'members', null);
            });
            channel.subscribe((status, subscribeError) => {
              if (status === 'SUBSCRIBED') {
                entry.status = { kind: 'presence' };
                for (const waiter of entry.waiters) waiter.resolve();
                entry.waiters.clear();
                broadcast(entry, 'presence', { presence: channel.presenceState(), ready: true });
              } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                const message = subscribeError?.message ?? `Realtime channel ${status.toLowerCase()}.`;
                entry.status = { kind: 'error', message };
                cancelWaiters(entry, message);
                broadcast(entry, 'error', { message });
              }
            });
          } catch (error) {
            entry.setupFailed = true;
            try {
              if (await client.removeChannel(channel) === 'ok') {
                channels.delete(groupId);
                subscriptions.delete(subscriptionId);
                entry.subscriptions.clear();
              }
            } catch {
              // Keep the entry for an explicit close or disposal retry.
            }
            throw error;
          }
          data = null;
          break;
        }
        case 'send-signal': {
          const result = await channelFor(call.payload.subscriptionId, call.payload.epoch, call.payload.groupId).send({ type: 'broadcast', event: 'signal', payload: { envelope: call.payload.envelope } });
          if (result !== 'ok') throw new Error('Supabase did not confirm sending the Realtime signal.');
          data = result;
          break;
        }
        case 'track-presence': {
          await waitUntilSubscribed(call.payload.subscriptionId, call.payload.epoch, call.payload.groupId);
          const result = await channelFor(call.payload.subscriptionId, call.payload.epoch, call.payload.groupId).track({ userId: call.payload.userId, status: call.payload.status });
          if (result !== 'ok') throw new Error('Supabase did not confirm tracking Realtime presence.');
          data = result;
          break;
        }
        case 'close-channel': {
          const { subscriptionId, epoch, groupId } = call.payload;
          const subscription = subscriptions.get(subscriptionId);
          if (subscription && subscription.epoch === epoch && subscription.group.groupId === groupId) {
            const entry = subscription.group;
            if (entry.subscriptions.size === 1) {
              const result = await client.removeChannel(entry.channel);
              if (result !== 'ok') throw new Error('Supabase did not confirm closing the Realtime channel.');
              channels.delete(groupId);
            }
            cancelWaiters(entry, 'Cloud subscription is unavailable.', subscriptionId);
            entry.subscriptions.delete(subscriptionId);
            subscriptions.delete(subscriptionId);
            data = 'ok';
          } else data = null;
          break;
        }
        case 'dispose': {
          const current = [...channels.values()];
          const removals = await Promise.allSettled(current.map((entry) => client.removeChannel(entry.channel)));
          removals.forEach((result, index) => {
            const entry = current[index]!;
            if (result.status === 'fulfilled' && result.value === 'ok') {
              channels.delete(entry.groupId);
              for (const id of entry.subscriptions.keys()) subscriptions.delete(id);
              cancelWaiters(entry, 'Cloud subscription is unavailable.');
              entry.subscriptions.clear();
            }
          });
          const removalFailure = removals.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          const removalStatusFailure = removals.find((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled' && result.value !== 'ok');
          if (removalFailure) throw removalFailure.reason;
          if (removalStatusFailure) throw new Error('Supabase did not confirm closing all Realtime channels.');
          data = null;
          break;
        }
      }
      return { version: 1, ok: true, value: { data, error: null } };
  };
  return {
    handle(call): Promise<JsonResponse> {
      return call.op === 'send-signal' || call.op === 'track-presence' ? run(call) : serialize(() => run(call));
    },
  };
}
