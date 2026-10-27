import type { CloudConnectionStatus, GroupInvite, GroupMember, GroupPresenceStatus, GroupSummary, IdentitySignature, PublicIdentity, UserProfile } from './cloud-contracts';
import type { GroupInviteSummary, GroupLeaveResult, UserProfileUpdate } from './cloud-contracts';
import type { SignedAckEnvelope, SignedChatEnvelope, SignedProtocolEnvelope } from './webrtc-protocol';

export interface ChatMessage {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string;
  authorInitials: string;
  content: string;
  sequence: number;
  createdAt: string;
}


export interface SelectedDisplaySource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
}

export interface TurnCredentialServer {
  urls: string | readonly string[];
  username: string;
  credential: string;
}

export interface LarpBridge {
  getCloudStatus(): Promise<CloudConnectionStatus>;
  refreshCloud(): Promise<CloudConnectionStatus>;
  getPublicIdentity(): Promise<PublicIdentity>;
  signIdentityPayload(payload: string): Promise<IdentitySignature>;
  verifyIdentityPayload(payload: string, signature: IdentitySignature, publicKey: string): Promise<boolean>;
  createCloudGroup(name: string): Promise<GroupSummary>;
  createCloudInvite(groupId: string): Promise<GroupInvite>;
  listCloudInvites(groupId: string): Promise<GroupInviteSummary[]>;
  acceptCloudInvite(code: string): Promise<GroupSummary>;
  revokeCloudInvite(groupId: string, inviteId: string): Promise<void>;
  removeCloudMember(groupId: string, memberUserId: string): Promise<void>;
  leaveCloudGroup(groupId: string): Promise<GroupLeaveResult>;
  getCloudMembers(groupId: string): Promise<GroupMember[]>;
  getMyProfile(): Promise<UserProfile | null>;
  saveMyProfile(profile: UserProfileUpdate): Promise<UserProfile>;
  subscribeCloudMembers(
    groupId: string,
    onMembers: (members: GroupMember[]) => void,
    onError: (message: string) => void,
  ): () => void;
  subscribeCloudPresence(
    groupId: string,
    onPresence: (presence: Record<string, GroupPresenceStatus>, ready: boolean) => void,
    onError: (message: string) => void,
  ): () => void;
  setCloudPresence(groupId: string, status: GroupPresenceStatus): Promise<void>;
  getTurnServers(groupId: string): Promise<readonly TurnCredentialServer[]>;
  getCachedCloudGroups(): Promise<GroupSummary[]>;
  getCachedCloudMembers(groupId: string): Promise<GroupMember[]>;
  getCachedMessages(groupId: string, perAuthorLimit?: number): Promise<readonly SignedChatEnvelope[]>;
  acquireScreenShare(groupId: string): Promise<boolean>;
  releaseScreenShare(groupId: string): Promise<void>;
  listDisplaySources(): Promise<SelectedDisplaySource[]>;
  prepareDisplayCapture(sourceId: string, includeSystemAudio: boolean): Promise<void>;
  setScreenViewerExpanded(expanded: boolean): Promise<void>;
  persistOutgoingEnvelope(message: SignedChatEnvelope): Promise<void>;
  persistVerifiedEnvelope(message: SignedChatEnvelope): Promise<'inserted' | 'duplicate' | 'conflict'>;
  readMissingEnvelopes(groupId: string, authorId: string, afterSequence: number, throughSequence: number, limit: number): Promise<readonly SignedChatEnvelope[]>;
  persistMessageAcknowledgement(acknowledgement: SignedAckEnvelope): Promise<void>;
  getHighestContiguousSequence(groupId: string, authorId: string): Promise<number>;
  getRecentMessages(groupId: string, perAuthorLimit?: number): Promise<readonly SignedChatEnvelope[]>;
  sendSignal(groupId: string, envelope: SignedProtocolEnvelope): Promise<void>;
  subscribeSignals(groupId: string, onSignal: (senderId: string, envelope: SignedProtocolEnvelope) => void, onError: (message: string) => void): () => void;
}
