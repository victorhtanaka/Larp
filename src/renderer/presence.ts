import type { GroupPresenceStatus } from '../shared/cloud-contracts';

export type MemberPresenceStatus = GroupPresenceStatus | 'offline';
export const PRESENCE_IDLE_TIMEOUT_MS = 5 * 60_000;

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

export function resolveLocalPresenceStatus(
  visible: boolean,
  focused: boolean,
  lastActivityAt: number,
  now: number,
): GroupPresenceStatus {
  return visible && focused && now - lastActivityAt < PRESENCE_IDLE_TIMEOUT_MS ? 'online' : 'away';
}
