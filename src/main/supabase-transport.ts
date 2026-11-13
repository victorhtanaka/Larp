import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { HostCall, JsonResponse } from '../shared/native-core-contracts';
type IngestCloudEvent = (subscriptionId: string, epoch: number, eventJson: string) => Promise<void>;
type RealtimeClient = Pick<SupabaseClient, 'realtime' | 'channel' | 'removeChannel'>;
type RealtimeClientFactory = (
  url: string,
  anonKey: string,
  options: { accessToken: () => Promise<string> },
) => RealtimeClient;
interface ChannelEntry { channel: RealtimeChannel; groupId: string; epoch: number }

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
  const sendEvent = (id: string, epoch: number, kind: string, payload: unknown): void => {
    void ingestCloudEvent(id, epoch, JSON.stringify({ subscriptionId: id, epoch, kind, payload })).catch(() => undefined);
  };
  const channelFor = (id: string, epoch: number, groupId: string): RealtimeChannel => {
    const entry = channels.get(id);
    if (!entry || entry.epoch !== epoch || entry.groupId !== groupId) throw new Error('Cloud subscription is unavailable.');
    return entry.channel;
  };
  const setAccessToken = async (accessToken: string): Promise<void> => {
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new TypeError('Access token is invalid.');
    await client.realtime.setAuth(accessToken);
    currentAccessToken = accessToken;
  };

  return {
    async handle(call): Promise<JsonResponse> {
      let data: unknown;
      switch (call.op) {
        case 'set-auth': {
          await setAccessToken(call.payload.accessToken);
          data = null;
          break;
        }
        case 'open-channel': {
          const { subscriptionId, epoch, groupId, userId, accessToken } = call.payload;
          if (channels.has(subscriptionId)) throw new Error('Subscription identifier is already active.');
          if (!userId) throw new TypeError('User ID is invalid.');
          await setAccessToken(accessToken);
          const channel = client.channel(`group:${groupId}`, { config: { private: true, broadcast: { ack: true, self: false }, presence: { key: userId } } });
          const entry = { channel, groupId, epoch };
          channels.set(subscriptionId, entry);
          channel.on('broadcast', { event: 'signal' }, (message) => sendEvent(subscriptionId, epoch, 'signal', message.payload));
          channel.on('presence', { event: 'sync' }, () => sendEvent(subscriptionId, epoch, 'presence', { presence: channel.presenceState(), ready: true }));
          channel.on('postgres_changes', { event: '*', schema: 'public', table: 'larp_group_members', filter: `group_id=eq.${groupId}` }, () => {
            sendEvent(subscriptionId, epoch, 'members', null);
          });
          channel.on('postgres_changes', { event: '*', schema: 'public', table: 'larp_user_profiles' }, () => {
            sendEvent(subscriptionId, epoch, 'members', null);
          });
          channel.subscribe((status, subscribeError) => {
            if (status === 'SUBSCRIBED') sendEvent(subscriptionId, epoch, 'presence', { presence: channel.presenceState(), ready: true });
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              sendEvent(subscriptionId, epoch, 'error', { message: subscribeError?.message ?? `Realtime channel ${status.toLowerCase()}.` });
            }
          });
          return { version: 1, ok: true, value: { data: null, error: null } };
        }
        case 'send-signal': {
          const result = await channelFor(call.payload.subscriptionId, call.payload.epoch, call.payload.groupId).send({ type: 'broadcast', event: 'signal', payload: { envelope: call.payload.envelope } });
          if (result !== 'ok') throw new Error('Supabase did not confirm sending the Realtime signal.');
          data = result;
          break;
        }
        case 'track-presence': {
          const result = await channelFor(call.payload.subscriptionId, call.payload.epoch, call.payload.groupId).track({ userId: call.payload.userId, status: call.payload.status });
          if (result !== 'ok') throw new Error('Supabase did not confirm tracking Realtime presence.');
          data = result;
          break;
        }
        case 'close-channel': {
          const entry = channels.get(call.payload.subscriptionId);
          if (entry && entry.epoch === call.payload.epoch && entry.groupId === call.payload.groupId) {
            const result = await client.removeChannel(entry.channel);
            if (result !== 'ok') throw new Error('Supabase did not confirm closing the Realtime channel.');
            if (channels.get(call.payload.subscriptionId) === entry) channels.delete(call.payload.subscriptionId);
            data = result;
          } else data = null;
          break;
        }
        case 'dispose': {
          const current = [...channels.entries()];
          const removals = await Promise.allSettled(current.map(([, entry]) => client.removeChannel(entry.channel)));
          removals.forEach((result, index) => {
            const [id, entry] = current[index]!;
            if (result.status === 'fulfilled' && result.value === 'ok' && channels.get(id) === entry) channels.delete(id);
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
    },
  };
}
