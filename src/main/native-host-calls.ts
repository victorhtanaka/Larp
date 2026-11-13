import { projectEnvelope } from './envelope-projection';
import type { SupabaseTransport } from './supabase-transport';
import type { HostCall, JsonResponse } from '../shared/native-core-contracts';

const MAX_HOST_CALL_BYTES = 8 * 1024 * 1024;
const MAX_HOST_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface NativeHostAdapters {
  secrets(call: Extract<HostCall, { kind: 'secrets' }>): Promise<JsonResponse>;
  cloud(): SupabaseTransport | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('Cloud epoch is invalid.');
  return value as number;
}

function parseHostCall(requestJson: string): HostCall {
  if (Buffer.byteLength(requestJson, 'utf8') > MAX_HOST_CALL_BYTES) throw new RangeError('Native host call exceeds the permitted size.');
  let raw: unknown;
  try { raw = JSON.parse(requestJson); } catch { throw new TypeError('Native host call is not valid JSON.'); }
  const request = requireRecord(raw, 'Native host call');
  if (!hasExactKeys(request, ['version', 'kind', 'op', 'payload']) || request.version !== 1) {
    throw new TypeError('Native host call envelope is invalid.');
  }
  const payload = requireRecord(request.payload, 'Native host call payload');
  const { kind, op } = request;

  if (kind === 'secrets') {
    if (op === 'available') {
      if (!hasExactKeys(payload, [])) throw new TypeError('Secrets payload is invalid.');
    } else if (op === 'encrypt') {
      if (!hasExactKeys(payload, ['plaintextBase64'])) throw new TypeError('Secrets payload is invalid.');
      requireString(payload.plaintextBase64, 'Plaintext');
    } else if (op === 'decrypt') {
      if (!hasExactKeys(payload, ['ciphertextBase64'])) throw new TypeError('Secrets payload is invalid.');
      requireString(payload.ciphertextBase64, 'Ciphertext');
    } else throw new TypeError('Secrets operation is not allowed.');
  } else if (kind === 'codec') {
    if (op !== 'project-envelope' || !hasExactKeys(payload, ['envelopeJson'])) throw new TypeError('Codec call is invalid.');
    requireString(payload.envelopeJson, 'Envelope JSON');
  } else if (kind === 'cloud') {
    if (typeof op !== 'string') throw new TypeError('Cloud operation is invalid.');
    switch (op) {
      case 'set-auth':
        if (!hasExactKeys(payload, ['accessToken'])) throw new TypeError('Authentication request is invalid.');
        if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) throw new TypeError('Access token is invalid.');
        break;
      case 'dispose':
        if (!hasExactKeys(payload, [])) throw new TypeError('Cloud payload is invalid.');
        break;
      case 'open-channel':
        if (!hasExactKeys(payload, ['subscriptionId', 'epoch', 'groupId', 'userId', 'accessToken'])) throw new TypeError('Channel request is invalid.');
        requireString(payload.subscriptionId, 'Subscription ID');
        requireEpoch(payload.epoch);
        requireString(payload.groupId, 'Group ID');
        requireString(payload.userId, 'User ID');
        if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) throw new TypeError('Access token is invalid.');
        break;
      case 'send-signal':
        if (!hasExactKeys(payload, ['subscriptionId', 'epoch', 'groupId', 'envelope']) || !isRecord(payload.envelope)) {
          throw new TypeError('Signal request is invalid.');
        }
        requireString(payload.subscriptionId, 'Subscription ID');
        requireEpoch(payload.epoch);
        requireString(payload.groupId, 'Group ID');
        break;
      case 'track-presence':
        if (!hasExactKeys(payload, ['subscriptionId', 'epoch', 'groupId', 'userId', 'status'])
          || (payload.status !== 'online' && payload.status !== 'away')) throw new TypeError('Presence request is invalid.');
        requireString(payload.subscriptionId, 'Subscription ID');
        requireEpoch(payload.epoch);
        requireString(payload.groupId, 'Group ID');
        requireString(payload.userId, 'User ID');
        break;
      case 'close-channel':
        if (!hasExactKeys(payload, ['subscriptionId', 'epoch', 'groupId'])) throw new TypeError('Channel request is invalid.');
        requireString(payload.subscriptionId, 'Subscription ID');
        requireEpoch(payload.epoch);
        requireString(payload.groupId, 'Group ID');
        break;
      default:
        throw new TypeError('Cloud operation is not allowed.');
    }
  } else throw new TypeError('Native host-call kind is invalid.');

  return request as unknown as HostCall;
}

function failureResponse(error: unknown): JsonResponse {
  const message = error instanceof Error ? error.message : 'Native host call failed.';
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'HOST_CALL_FAILED';
  return { version: 1, ok: false, error: { code, message } };
}

export function createNativeHostCall(adapters: NativeHostAdapters): (requestJson: string) => Promise<string> {
  return async (requestJson: string): Promise<string> => {
    let response: JsonResponse;
    try {
      const call = parseHostCall(requestJson);
      if (call.kind === 'secrets') response = await adapters.secrets(call);
      else if (call.kind === 'codec') response = { version: 1, ok: true, value: projectEnvelope(call.payload.envelopeJson) };
      else {
        const transport = adapters.cloud();
        if (!transport && call.op === 'dispose') response = { version: 1, ok: true, value: { data: null, error: null } };
        else if (!transport) throw Object.assign(new Error('Supabase transport is not configured.'), { code: 'CLOUD_NOT_CONFIGURED' });
        else response = await transport.handle(call);
      }
    } catch (error) {
      response = failureResponse(error);
    }

    const fallback = '{"version":1,"ok":false,"error":{"code":"HOST_CALL_FAILED","message":"Native host response could not be encoded."}}';
    let serialized: string;
    try {
      const encoded = JSON.stringify(response);
      serialized = typeof encoded === 'string' ? encoded : fallback;
    } catch {
      serialized = fallback;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HOST_RESPONSE_BYTES) {
      serialized = '{"version":1,"ok":false,"error":{"code":"HOST_CALL_FAILED","message":"Native host response exceeds the permitted size."}}';
    }
    return serialized;
  };
}
