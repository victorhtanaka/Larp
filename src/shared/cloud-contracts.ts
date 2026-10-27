export type CloudConfigurationStatus =
  | { status: 'configured'; url: string; anonKey: string }
  | { status: 'not-configured'; missing: readonly ('url' | 'anonKey')[] };

export interface PublicIdentity {
  algorithm: 'Ed25519';
  publicKey: string;
}

export interface IdentitySignature {
  algorithm: 'Ed25519';
  signature: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  role: 'owner' | 'member';
}

export const USER_PROFILE_NAME_MAX_LENGTH = 32;
export const USER_PROFILE_AVATAR_MAX_BYTES = 48 * 1024;
export const USER_PROFILE_AVATAR_MAX_DATA_URI_LENGTH = 66_000;
export const USER_PROFILE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export interface UserProfile {
  userId: string;
  displayName: string | null;
  avatarData: string | null;
}

export type UserProfileUpdate = Pick<UserProfile, 'displayName' | 'avatarData'>;

export interface GroupMember {
  userId: string;
  publicKey: string;
  joinedAt: string;
  role: 'owner' | 'member';
  profile: UserProfile | null;
}

export interface GroupInvite {
  id: string;
  code: string;
  expiresAt: string;
}
export interface GroupInviteSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface GroupLeaveResult {
  deleted: boolean;
  group: GroupSummary | null;
}

export type CloudConnectionStatus =
  | { state: 'connecting'; detail: string; groups: [] }
  | { state: 'not-configured'; detail: string; groups: [] }
  | { state: 'unavailable'; detail: string; groups: [] }
  | { state: 'ready'; detail: string; groups: GroupSummary[]; userId: string };
