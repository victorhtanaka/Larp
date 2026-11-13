import type { IdentitySignature } from '../shared/cloud-contracts';
import {
  envelopeSigningBytes,
  parseProtocolEnvelope,
  serializeStoredEnvelope,
  type ProtocolErrorCode,
  type SignedProtocolEnvelope,
} from '../shared/webrtc-protocol';

export interface EnvelopeProjection {
  ok: true;
  envelopeJson: string;
  signingBytesBase64: string;
  storageJson: string | null;
  signature: IdentitySignature;
  header: {
    kind: SignedProtocolEnvelope['kind'];
    groupId: string;
    senderId: string;
    recipientId: string | null;
    messageId: string | null;
    sequence: number | null;
    authorId: string | null;
    requestId: string | null;
    afterSequence: number | null;
    throughSequence: number | null;
    limit: number | null;
  };
  messages: EnvelopeProjection[];
}

export type EnvelopeProjectionResult = EnvelopeProjection | { ok: false; code: ProtocolErrorCode };

function projectValidatedEnvelope(envelope: SignedProtocolEnvelope, envelopeJson: string): EnvelopeProjection {
  const storedKind = envelope.kind === 'chat' || envelope.kind === 'ack' ? envelope.kind : null;
  const header: EnvelopeProjection['header'] = {
    kind: envelope.kind,
    groupId: envelope.groupId,
    senderId: envelope.senderId,
    recipientId: 'recipientId' in envelope ? envelope.recipientId : null,
    messageId: 'messageId' in envelope ? envelope.messageId : null,
    sequence: 'sequence' in envelope ? envelope.sequence : null,
    authorId: 'authorId' in envelope ? envelope.authorId : null,
    requestId: 'requestId' in envelope ? envelope.requestId : null,
    afterSequence: 'afterSequence' in envelope ? envelope.afterSequence : null,
    throughSequence: 'throughSequence' in envelope ? envelope.throughSequence : null,
    limit: 'limit' in envelope ? envelope.limit : null,
  };
  const messages = envelope.kind === 'sync-batch'
    ? envelope.messages.map((message) => projectValidatedEnvelope(message, JSON.stringify(message)))
    : [];
  return {
    ok: true,
    envelopeJson,
    signingBytesBase64: Buffer.from(envelopeSigningBytes(envelope)).toString('base64'),
    storageJson: storedKind === null ? null : serializeStoredEnvelope(envelope, storedKind),
    signature: envelope.signature,
    header,
    messages,
  };
}

export function projectEnvelope(envelopeJson: string): EnvelopeProjectionResult {
  const parsed = parseProtocolEnvelope(envelopeJson);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return projectValidatedEnvelope(parsed.envelope, envelopeJson);
}
