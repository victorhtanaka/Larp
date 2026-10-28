import type { GroupPresenceStatus } from '../shared/cloud-contracts';

export type MemberPresenceStatus = GroupPresenceStatus | 'offline';

export function resolveMemberPresence(
  memberId: string,
  localUserId: string | undefined,
  localStatus: MemberPresenceStatus,
  sharedStatusByUserId: Readonly<Record<string, GroupPresenceStatus>>,
  ready: boolean,
): MemberPresenceStatus | undefined {
  if (!ready) return undefined;
  if (memberId === localUserId) return localStatus;
  return sharedStatusByUserId[memberId] ?? 'offline';
}

