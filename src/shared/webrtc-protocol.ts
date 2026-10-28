import type { IdentitySignature } from './cloud-contracts';
export const WEBRTC_PROTOCOL_VERSION = 1 as const;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const MAX_CHAT_CONTENT_BYTES = 8 * 1024;
export const MAX_SYNC_BATCH_MESSAGES = 6;
export const MAX_SYNC_RANGE = 10_000;
export const MAX_SDP_BYTES = 32 * 1024;
export const MAX_ICE_CANDIDATES_PER_BATCH = 8;
export const MAX_ICE_CANDIDATE_BYTES = 4 * 1024;

export interface SignedChatEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'chat';
  readonly groupId: string;
  readonly senderId: string;
  readonly messageId: string;
  /** Monotonic sequence within this author's stream, not group-global. */
  readonly sequence: number;
  readonly content: string;
  readonly createdAt: string;
  readonly signature: IdentitySignature;
}

export interface SignedAckEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'ack';
  readonly groupId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly signature: IdentitySignature;
}

export interface SignedSyncRequestEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'sync-request';
  readonly groupId: string;
  readonly senderId: string;
  readonly authorId: string;
  readonly requestId: string;
  readonly afterSequence: number;
  readonly throughSequence: number;
  readonly limit: number;
  readonly signature: IdentitySignature;
}

export interface SignedSyncBatchEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'sync-batch';
  readonly groupId: string;
  readonly senderId: string;
  readonly authorId: string;
  readonly requestId: string;
  readonly afterSequence: number;
  readonly throughSequence: number;
  readonly messages: readonly SignedChatEnvelope[];
  readonly complete: boolean;
  readonly signature: IdentitySignature;
}

export interface SignedDescriptionEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'description';
  readonly groupId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly negotiationId: string;
  readonly description: {
    readonly type: 'offer' | 'answer';
    readonly sdp: string;
  };
  readonly signature: IdentitySignature;
}

export interface SignedIceBatchEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'ice-batch';
  readonly groupId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly negotiationId: string;
  readonly candidates: readonly RTCIceCandidateInit[];
  readonly endOfCandidates: boolean;
  readonly signature: IdentitySignature;
}

export interface SignedConnectRequestEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'connect-request';
  readonly groupId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly signature: IdentitySignature;
}

export interface SignedMediaStateEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'media-state';
  readonly groupId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly media: 'voice' | 'screen';
  readonly active: boolean;
  readonly signature: IdentitySignature;
}


export const PROTOCOL_ERROR_CODES = [
  'version-mismatch',
  'malformed-envelope',
  'oversized-envelope',
  'invalid-signature',
  'unauthorized-sender',
  'duplicate-id-conflict',
  'peer-limit-exceeded',
  'transport-closed',
  'sync-unavailable',
  'internal-error',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface SignedProtocolErrorEnvelope {
  readonly version: typeof WEBRTC_PROTOCOL_VERSION;
  readonly kind: 'protocol-error';
  readonly groupId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly code: ProtocolErrorCode;
  readonly detail: string;
  readonly signature: IdentitySignature;
}

export type SignedProtocolEnvelope =
  | SignedChatEnvelope
  | SignedAckEnvelope
  | SignedSyncRequestEnvelope
  | SignedSyncBatchEnvelope
  | SignedDescriptionEnvelope
  | SignedIceBatchEnvelope
  | SignedConnectRequestEnvelope
  | SignedMediaStateEnvelope
  | SignedProtocolErrorEnvelope;

export type UnsignedProtocolEnvelope =
  | Omit<SignedChatEnvelope, 'signature'>
  | Omit<SignedAckEnvelope, 'signature'>
  | Omit<SignedSyncRequestEnvelope, 'signature'>
  | Omit<SignedSyncBatchEnvelope, 'signature'>
  | Omit<SignedDescriptionEnvelope, 'signature'>
  | Omit<SignedIceBatchEnvelope, 'signature'>
  | Omit<SignedConnectRequestEnvelope, 'signature'>
  | Omit<SignedMediaStateEnvelope, 'signature'>
  | Omit<SignedProtocolErrorEnvelope, 'signature'>;


export interface IdentitySigner {
  readonly participantId: string;
  sign(bytes: Uint8Array): Promise<IdentitySignature>;
}

export interface IdentityVerifier {
  verify(
    participantId: string,
    bytes: Uint8Array,
    signature: IdentitySignature,
    publicKey?: string,
  ): Promise<boolean>;
}

export type ProtocolValidationCode =
  | 'version-mismatch'
  | 'malformed-envelope'
  | 'oversized-envelope';

export type ParsedProtocolEnvelope =
  | { readonly ok: true; readonly envelope: SignedProtocolEnvelope }
  | { readonly ok: false; readonly code: ProtocolValidationCode };

const encoder = new TextEncoder();
const ID_MAX_LENGTH = 128;
const SIGNATURE_MAX_LENGTH = 256;
const SIGNATURE_MIN_LENGTH = 1;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= ID_MAX_LENGTH
    && /^[A-Za-z0-9._:@-]+$/u.test(value);
}

function hasUtf8Limit(value: unknown, limit: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && encoder.encode(value).byteLength <= limit;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRangeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSignature(value: unknown): value is IdentitySignature {
  return isRecord(value)
    && hasExactKeys(value, ['algorithm', 'signature'])
    && value.algorithm === 'Ed25519'
    && typeof value.signature === 'string'
    && value.signature.length >= SIGNATURE_MIN_LENGTH
    && value.signature.length <= SIGNATURE_MAX_LENGTH
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(value.signature);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isSignedChat(value: unknown): value is SignedChatEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'kind', 'groupId', 'senderId', 'messageId', 'sequence', 'content', 'createdAt', 'signature',
  ])) return false;
  return value.version === WEBRTC_PROTOCOL_VERSION
    && value.kind === 'chat'
    && isId(value.groupId)
    && isId(value.senderId)
    && isId(value.messageId)
    && isSequence(value.sequence)
    && hasUtf8Limit(value.content, MAX_CHAT_CONTENT_BYTES)
    && isDate(value.createdAt)
    && isSignature(value.signature);
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!isRecord(value)) return false;
  const keys = ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'];
  if (!Object.keys(value).every((key) => keys.includes(key))) return false;
  if (!Object.hasOwn(value, 'candidate') || !hasUtf8Limit(value.candidate, MAX_ICE_CANDIDATE_BYTES)) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && !hasUtf8Limit(value.sdpMid, 256)) return false;
  if (value.sdpMLineIndex !== undefined && value.sdpMLineIndex !== null
    && (!Number.isInteger(value.sdpMLineIndex) || (value.sdpMLineIndex as number) < 0)) return false;
  return value.usernameFragment === undefined
    || value.usernameFragment === null
    || hasUtf8Limit(value.usernameFragment, 256);
}

export function validateProtocolEnvelope(value: unknown): ParsedProtocolEnvelope {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, code: 'malformed-envelope' };
  }
  if (typeof serialized !== 'string') return { ok: false, code: 'malformed-envelope' };
  if (encoder.encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    return { ok: false, code: 'oversized-envelope' };
  }
  if (!isRecord(value)) return { ok: false, code: 'malformed-envelope' };
  if (value.version !== WEBRTC_PROTOCOL_VERSION) return { ok: false, code: 'version-mismatch' };
  if (!isSignature(value.signature) || !isId(value.senderId)) {
    return { ok: false, code: 'malformed-envelope' };
  }

  let valid = false;
  switch (value.kind) {
    case 'chat':
      valid = isSignedChat(value);
      break;
    case 'ack':
      valid = hasExactKeys(value, ['version', 'kind', 'groupId', 'senderId', 'messageId', 'sequence', 'signature'])
        && isId(value.groupId)
        && isId(value.messageId)
        && isSequence(value.sequence);
      break;
    case 'sync-request':
      valid = hasExactKeys(value, [
        'version', 'kind', 'groupId', 'senderId', 'authorId', 'requestId', 'afterSequence', 'throughSequence', 'limit', 'signature',
      ])
        && isId(value.groupId)
        && isId(value.authorId)
        && isId(value.requestId)
        && isRangeSequence(value.afterSequence)
        && isSequence(value.throughSequence)
        && (value.throughSequence as number) > (value.afterSequence as number)
        && (value.throughSequence as number) - (value.afterSequence as number) <= MAX_SYNC_RANGE
        && Number.isInteger(value.limit)
        && (value.limit as number) > 0
        && (value.limit as number) <= MAX_SYNC_BATCH_MESSAGES;
      break;
    case 'sync-batch': {
      const messages = value.messages;
      let validMessages = Array.isArray(messages) && messages.length <= MAX_SYNC_BATCH_MESSAGES;
      if (validMessages) {
        let lastSequence = (value.afterSequence as number);
        for (const message of messages as unknown[]) {
          if (!isSignedChat(message)
            || message.groupId !== value.groupId
            || message.senderId !== value.authorId
            || message.sequence !== lastSequence + 1
            || message.sequence > (value.throughSequence as number)) {
            validMessages = false;
            break;
          }
          lastSequence = message.sequence;
        }
      }
      valid = hasExactKeys(value, [
        'version', 'kind', 'groupId', 'senderId', 'authorId', 'requestId', 'afterSequence', 'throughSequence', 'messages', 'complete', 'signature',
      ])
        && isId(value.groupId)
        && isId(value.authorId)
        && isId(value.requestId)
        && isRangeSequence(value.afterSequence)
        && isSequence(value.throughSequence)
        && (value.throughSequence as number) > (value.afterSequence as number)
        && (value.throughSequence as number) - (value.afterSequence as number) <= MAX_SYNC_RANGE
        && typeof value.complete === 'boolean'
        && validMessages;
      break;
    }
    case 'description': {
      const description = value.description;
      valid = hasExactKeys(value, [
        'version', 'kind', 'groupId', 'senderId', 'recipientId', 'negotiationId', 'description', 'signature',
      ])
        && isId(value.groupId)
        && isId(value.recipientId)
        && isId(value.negotiationId)
        && isRecord(description)
        && hasExactKeys(description, ['type', 'sdp'])
        && (description.type === 'offer' || description.type === 'answer')
        && hasUtf8Limit(description.sdp, MAX_SDP_BYTES);
      break;
    }
    case 'ice-batch':
      valid = hasExactKeys(value, [
        'version', 'kind', 'groupId', 'senderId', 'recipientId', 'negotiationId', 'candidates', 'endOfCandidates', 'signature',
      ])
        && isId(value.groupId)
        && isId(value.recipientId)
        && isId(value.negotiationId)
        && Array.isArray(value.candidates)
        && value.candidates.length <= MAX_ICE_CANDIDATES_PER_BATCH
        && value.candidates.every(isCandidate)
        && typeof value.endOfCandidates === 'boolean';
      break;
    case 'connect-request':
      valid = hasExactKeys(value, ['version', 'kind', 'groupId', 'senderId', 'recipientId', 'signature'])
        && isId(value.groupId)
        && isId(value.recipientId);
      break;
    case 'media-state':
      valid = hasExactKeys(value, ['version', 'kind', 'groupId', 'senderId', 'recipientId', 'media', 'active', 'signature'])
        && isId(value.groupId)
        && isId(value.recipientId)
        && (value.media === 'voice' || value.media === 'screen')
        && typeof value.active === 'boolean';
      break;

    case 'protocol-error':
      valid = hasExactKeys(value, [
        'version', 'kind', 'groupId', 'senderId', 'recipientId', 'code', 'detail', 'signature',
      ])
        && isId(value.groupId)
        && isId(value.recipientId)
        && (PROTOCOL_ERROR_CODES as readonly unknown[]).includes(value.code)
        && hasUtf8Limit(value.detail, 200, true);
      break;
    default:
      valid = false;
  }

  return valid
    ? { ok: true, envelope: value as unknown as SignedProtocolEnvelope }
    : { ok: false, code: 'malformed-envelope' };
}

export function parseProtocolEnvelope(raw: unknown): ParsedProtocolEnvelope {
  if (typeof raw !== 'string') return { ok: false, code: 'malformed-envelope' };
  if (encoder.encode(raw).byteLength > MAX_ENVELOPE_BYTES) {
    return { ok: false, code: 'oversized-envelope' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'malformed-envelope' };
  }
  return validateProtocolEnvelope(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function envelopeSigningBytes(envelope: SignedProtocolEnvelope | UnsignedProtocolEnvelope): Uint8Array {
  const unsigned = { ...envelope } as Record<string, unknown>;
  delete unsigned.signature;
  return encoder.encode(stableStringify(unsigned));
}

export async function signProtocolEnvelope<T extends UnsignedProtocolEnvelope>(
  envelope: T,
  signer: IdentitySigner,
): Promise<T & { readonly signature: IdentitySignature }> {
  if (!isRecord(envelope) || envelope.senderId !== signer.participantId) {
    throw new Error('Envelope signer does not match its sender.');
  }
  const signature = await signer.sign(encoder.encode(stableStringify(envelope)));
  const signed = { ...envelope, signature } as T & { readonly signature: IdentitySignature };
  const validation = validateProtocolEnvelope(signed);
  if (!validation.ok) throw new Error(`Invalid outgoing protocol envelope: ${validation.code}.`);
  return signed;
}

export async function verifyProtocolEnvelope(
  envelope: SignedProtocolEnvelope,
  verifier: IdentityVerifier,
  publicKey?: string,
): Promise<boolean> {
  const validation = validateProtocolEnvelope(envelope);
  if (!validation.ok) return false;
  return verifier.verify(envelope.senderId, envelopeSigningBytes(envelope), envelope.signature, publicKey);
}
