import { contextBridge, ipcRenderer } from 'electron';
import type { GroupMember } from '../shared/cloud-contracts';
import type { LarpBridge } from '../shared/contracts';
const bridge: LarpBridge = {
  getCloudStatus: () => ipcRenderer.invoke('cloud:get-status'),
  refreshCloud: () => ipcRenderer.invoke('cloud:refresh'),
  getPublicIdentity: () => ipcRenderer.invoke('identity:get-public'),
  signIdentityPayload: (payload) => ipcRenderer.invoke('identity:sign', { payload }),
  verifyIdentityPayload: (payload, signature, publicKey) => ipcRenderer.invoke('identity:verify', { payload, signature, publicKey }),
  createCloudGroup: (name) => ipcRenderer.invoke('cloud:create-group', name),
  createCloudInvite: (groupId) => ipcRenderer.invoke('cloud:create-invite', groupId),
  acceptCloudInvite: (code) => ipcRenderer.invoke('cloud:accept-invite', code),
  listCloudInvites: (groupId) => ipcRenderer.invoke('cloud:list-invites', groupId),
  revokeCloudInvite: (groupId, inviteId) => ipcRenderer.invoke('cloud:revoke-invite', { groupId, inviteId }),
  removeCloudMember: (groupId, memberUserId) => ipcRenderer.invoke('cloud:remove-member', { groupId, memberUserId }),
  leaveCloudGroup: (groupId) => ipcRenderer.invoke('cloud:leave-group', groupId),
  getCloudMembers: (groupId) => ipcRenderer.invoke('cloud:get-members', groupId),
  subscribeCloudMembers: (groupId, onMembers, onError) => {
    let active = true;
    const updateListener = (_event: Electron.IpcRendererEvent, input: { groupId: string; members: GroupMember[] }) => {
      if (active && input?.groupId === groupId && Array.isArray(input.members)) onMembers(input.members);
    };
    const errorListener = (_event: Electron.IpcRendererEvent, input: { groupId: string; message: string }) => {
      if (active && input?.groupId === groupId) onError(input.message);
    };
    ipcRenderer.on('cloud:members-update', updateListener);
    ipcRenderer.on('cloud:members-error', errorListener);
    const subscription = ipcRenderer.invoke('cloud:subscribe-members', groupId);
    void subscription.catch((cause: unknown) => {
      if (active) onError(cause instanceof Error ? cause.message : 'Não foi possível acompanhar os participantes.');
    });
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener('cloud:members-update', updateListener);
      ipcRenderer.removeListener('cloud:members-error', errorListener);
      void subscription.then(() => ipcRenderer.invoke('cloud:unsubscribe-members', groupId)).catch(() => undefined);
    };
  },
  getTurnServers: (groupId) => ipcRenderer.invoke('cloud:get-turn-servers', groupId),
  listDisplaySources: () => ipcRenderer.invoke('display:list-sources'),
  prepareDisplayCapture: (sourceId, includeSystemAudio) =>
    ipcRenderer.invoke('display:prepare', { sourceId, includeSystemAudio }),
  acquireScreenShare: (groupId) => ipcRenderer.invoke('screen-share:acquire', groupId),
  releaseScreenShare: (groupId) => ipcRenderer.invoke('screen-share:release', groupId),
  getCachedCloudGroups: () => ipcRenderer.invoke('cloud:get-cache'),
  getCachedCloudMembers: (groupId) => ipcRenderer.invoke('cloud:get-cached-members', groupId),
  getCachedMessages: (groupId, perAuthorLimit) => ipcRenderer.invoke('messages:read-cached', { groupId, perAuthorLimit }),
  persistOutgoingEnvelope: (message) => ipcRenderer.invoke('messages:persist-outgoing', message),
  persistVerifiedEnvelope: (message) => ipcRenderer.invoke('messages:persist-verified', message),
  readMissingEnvelopes: (groupId, authorId, afterSequence, throughSequence, limit) =>
    ipcRenderer.invoke('messages:read-missing', { groupId, authorId, afterSequence, throughSequence, limit }),
  persistMessageAcknowledgement: (acknowledgement) => ipcRenderer.invoke('messages:persist-ack', acknowledgement),
  getHighestContiguousSequence: (groupId, authorId) => ipcRenderer.invoke('messages:get-highest', { groupId, authorId }),
  getRecentMessages: (groupId, perAuthorLimit) => ipcRenderer.invoke('messages:read-recent', { groupId, perAuthorLimit }),
  sendSignal: (groupId, envelope) => ipcRenderer.invoke('signals:send', { groupId, envelope }),
  subscribeSignals: (groupId, onSignal, onError) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { groupId: string; senderId: string; envelope: Parameters<typeof onSignal>[1] }) => {
      if (input?.groupId === groupId) onSignal(input.senderId, input.envelope);
    };
    let active = true;
    ipcRenderer.on('signals:received', listener);
    const subscription = ipcRenderer.invoke('signals:subscribe', groupId);
    void subscription.catch((error: unknown) => {
      if (active) onError(error instanceof Error ? error.message : 'Signal subscription failed.');
    });
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener('signals:received', listener);
      void subscription.then(() => ipcRenderer.invoke('signals:unsubscribe', groupId)).catch((error: unknown) => {
        onError(error instanceof Error ? error.message : 'Signal unsubscribe failed.');
      });
    };
  },
};

contextBridge.exposeInMainWorld('larp', Object.freeze(bridge));
