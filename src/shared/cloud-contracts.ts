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

export interface GroupMember {
  userId: string;
  publicKey: string;
  joinedAt: string;
  role: 'owner' | 'member';
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
