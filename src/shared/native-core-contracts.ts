import type { GroupPresenceStatus, IdentitySignature, UserProfileUpdate } from './cloud-contracts';
import type { SignedAckEnvelope, SignedChatEnvelope, SignedProtocolEnvelope } from './webrtc-protocol';

export type CoreOperation =
  | 'getCloudStatus' | 'refreshCloud' | 'getPublicIdentity' | 'signIdentityPayload' | 'verifyIdentityPayload'
  | 'createCloudGroup' | 'createCloudInvite' | 'listCloudInvites' | 'acceptCloudInvite' | 'revokeCloudInvite'
  | 'removeCloudMember' | 'leaveCloudGroup' | 'getCloudMembers' | 'getMyProfile' | 'saveMyProfile'
  | 'subscribeCloudMembers' | 'subscribeCloudPresence' | 'getTurnServers' | 'getCachedCloudGroups'
  | 'getCachedCloudMembers' | 'getCachedMessages' | 'acquireScreenShare' | 'releaseScreenShare'
  | 'persistOutgoingEnvelope' | 'persistVerifiedEnvelope' | 'readMissingEnvelopes'
  | 'persistMessageAcknowledgement' | 'getHighestContiguousSequence' | 'getRecentMessages'
  | 'sendSignal' | 'subscribeSignals';

export type CorePayloadByOperation = {
  getCloudStatus: Record<string, never>; refreshCloud: Record<string, never>; getPublicIdentity: Record<string, never>;
  signIdentityPayload: { payloadBase64: string }; verifyIdentityPayload: { payloadBase64: string; signature: IdentitySignature; publicKey: string };
  createCloudGroup: { name: string }; createCloudInvite: { groupId: string }; listCloudInvites: { groupId: string };
  acceptCloudInvite: { code: string }; revokeCloudInvite: { groupId: string; inviteId: string };
  removeCloudMember: { groupId: string; memberUserId: string }; leaveCloudGroup: { groupId: string };
  getCloudMembers: { groupId: string }; getMyProfile: Record<string, never>; saveMyProfile: UserProfileUpdate;
  subscribeCloudMembers: { groupId: string; subscriptionId: string; epoch: number };
  subscribeCloudPresence: { groupId: string; subscriptionId: string; epoch: number };
  getTurnServers: { groupId: string }; getCachedCloudGroups: Record<string, never>;
  getCachedCloudMembers: { groupId: string }; getCachedMessages: { groupId: string; perAuthorLimit?: number };
  acquireScreenShare: { groupId: string }; releaseScreenShare: { groupId: string };
  persistOutgoingEnvelope: { message: SignedChatEnvelope }; persistVerifiedEnvelope: { message: SignedChatEnvelope };
  readMissingEnvelopes: { groupId: string; authorId: string; afterSequence: number; throughSequence: number; limit: number };
  persistMessageAcknowledgement: { acknowledgement: SignedAckEnvelope };
  getHighestContiguousSequence: { groupId: string; authorId: string };
  getRecentMessages: { groupId: string; perAuthorLimit?: number };
  sendSignal: { groupId: string; envelope: SignedProtocolEnvelope };
  subscribeSignals: { groupId: string; subscriptionId: string; epoch: number };
};

export type CoreRequest = { [O in CoreOperation]: { version: 1; op: O; payload: CorePayloadByOperation[O] } }[CoreOperation];
export type JsonError = null | boolean | number | string | readonly JsonError[] | { readonly [key: string]: JsonError };
export type JsonResponse<T = unknown> =
  | { version: 1; ok: true; value: T }
  | { version: 1; ok: false; error: { code: string; message: string } };

export interface NativeCloudConfiguration { url: string; anonKey: string }

export type HostCall =
  | { version: 1; kind: 'secrets'; op: 'available'; payload: Record<string, never> }
  | { version: 1; kind: 'secrets'; op: 'encrypt'; payload: { plaintextBase64: string } }
  | { version: 1; kind: 'secrets'; op: 'decrypt'; payload: { ciphertextBase64: string } }
  | { version: 1; kind: 'codec'; op: 'project-envelope'; payload: { envelopeJson: string } }
  | { version: 1; kind: 'cloud'; op: 'set-auth'; payload: { accessToken: string } }
  | { version: 1; kind: 'cloud'; op: 'open-channel'; payload: { subscriptionId: string; epoch: number; groupId: string; userId: string; accessToken: string } }
  | { version: 1; kind: 'cloud'; op: 'send-signal'; payload: { subscriptionId: string; epoch: number; groupId: string; envelope: SignedProtocolEnvelope } }
  | { version: 1; kind: 'cloud'; op: 'track-presence'; payload: { subscriptionId: string; epoch: number; groupId: string; userId: string; status: GroupPresenceStatus } }
  | { version: 1; kind: 'cloud'; op: 'close-channel'; payload: { subscriptionId: string; epoch: number; groupId: string } }
  | { version: 1; kind: 'cloud'; op: 'dispose'; payload: Record<string, never> };

export type CoreEventKind = 'members' | 'presence' | 'signal' | 'error';
export interface CoreEvent { subscriptionId: string; epoch: number; kind: CoreEventKind; payload: unknown }
export interface NativeLarpCore {
  request(requestJson: string): Promise<string>;
  ingestCloudEvent(subscriptionId: string, epoch: number, eventJson: string): Promise<void>;
  close(): Promise<void>;
}
export type HostCallFunction = (requestJson: string) => Promise<string>;
export type CoreEventFunction = (eventJson: string) => void;
