import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import type { CoreEvent, CoreOperation, CoreRequest } from '../shared/native-core-contracts';
import type { NativeCoreClient } from './native-core';
import { clearDesktopDisplayCapture, listDesktopDisplaySources, prepareDesktopDisplayCapture } from './display-capture';

const CORE_EVENT_KINDS = { members: true, presence: true, signal: true, error: true } as const;
type SubscriptionKind = 'members' | 'presence' | 'signals';
type SubscribeOperation = 'subscribeCloudMembers' | 'subscribeCloudPresence' | 'subscribeSignals';

interface SubscriptionState {
  key: string;
  subscriptionId: string;
  epoch: number;
  groupId: string;
  kind: SubscriptionKind;
  sender: WebContents;
  frame: WebFrameMain;
  active: boolean;
  opening: boolean;
  cancelSent: boolean;
  onDestroyed: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordInput(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function requireText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new TypeError(`${label} inválido.`);
  return value.trim();
}
function identityPayloadBase64(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) {
    throw new TypeError('Conteúdo de identidade inválido.');
  }
  return Buffer.from(value, 'utf8').toString('base64');
}

function assertTrustedFrame(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): void {
  if (!mainWindow || BrowserWindow.fromWebContents(event.sender) !== mainWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Origem IPC não autorizada.');
  }
}

function parseCoreEvent(eventJson: string): CoreEvent {
  if (Buffer.byteLength(eventJson, 'utf8') > 8 * 1024 * 1024) throw new TypeError('Native core event exceeds the permitted size.');
  let value: unknown;
  try { value = JSON.parse(eventJson); } catch { throw new TypeError('Native core event is malformed.'); }
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !Object.hasOwn(value, 'subscriptionId') || !Object.hasOwn(value, 'epoch')
    || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'payload')
    || typeof value.subscriptionId !== 'string'
    || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
    || typeof value.kind !== 'string' || !Object.hasOwn(CORE_EVENT_KINDS, value.kind)) {
    throw new TypeError('Native core event has an invalid shape.');
  }
  return value as unknown as CoreEvent;
}

function subscriptionKey(senderId: number, kind: SubscriptionKind, groupId: string): string {
  return JSON.stringify([senderId, kind, groupId]);
}

export function registerIpcHandlers(
  nativeCore: NativeCoreClient,
  getMainWindow: () => BrowserWindow | null,
): (eventJson: string) => void {
  const screenViewerRestoreState = new WeakMap<BrowserWindow, { wasMaximized: boolean; wasFullScreen: boolean }>();
  const subscriptionsById = new Map<string, SubscriptionState>();
  const activeSubscriptions = new Map<string, SubscriptionState>();
  let nextSubscriptionEpoch = 1;

  const invokeCore = async <T>(event: IpcMainInvokeEvent, op: CoreOperation, payload: unknown): Promise<T> => {
    assertTrustedFrame(event, getMainWindow());
    const request = { version: 1, op, payload } as CoreRequest;
    const result = await nativeCore.request(request);
    assertTrustedFrame(event, getMainWindow());
    return result as T;
  };

  const cancelNativeSubscription = (state: SubscriptionState): void => {
    if (state.opening || state.cancelSent) return;
    state.cancelSent = true;
    void nativeCore.cancelSubscription(state.subscriptionId, state.epoch).catch((error: unknown) => {
      if (isRecord(error) && (error.code === 'closed' || error.code === 'stale-context')) return;
      console.error('Não foi possível cancelar a inscrição nativa:', error);
    });
  };

  const disposeSubscription = (state: SubscriptionState): void => {
    if (!state.active) return;
    state.active = false;
    state.sender.removeListener('destroyed', state.onDestroyed);
    if (subscriptionsById.get(state.subscriptionId) === state) subscriptionsById.delete(state.subscriptionId);
    if (activeSubscriptions.get(state.key) === state) activeSubscriptions.delete(state.key);
    cancelNativeSubscription(state);
  };

  const subscribe = async (
    event: IpcMainInvokeEvent,
    groupValue: unknown,
    kind: SubscriptionKind,
    op: SubscribeOperation,
  ): Promise<boolean> => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireText(groupValue, 36, 'Grupo');
    const sender = event.sender;
    const frame = event.senderFrame;
    if (!frame) throw new Error('Frame principal indisponível.');
    const key = subscriptionKey(sender.id, kind, groupId);
    const prior = activeSubscriptions.get(key);
    if (prior) disposeSubscription(prior);
    if (!Number.isSafeInteger(nextSubscriptionEpoch) || nextSubscriptionEpoch > Number.MAX_SAFE_INTEGER) {
      throw new Error('A sequência de inscrições foi esgotada.');
    }
    const state: SubscriptionState = {
      key,
      subscriptionId: randomUUID(),
      epoch: nextSubscriptionEpoch++,
      groupId,
      kind,
      sender,
      frame,
      active: true,
      opening: true,
      cancelSent: false,
      onDestroyed: () => disposeSubscription(state),
    };
    subscriptionsById.set(state.subscriptionId, state);
    activeSubscriptions.set(key, state);
    sender.once('destroyed', state.onDestroyed);
    try {
      await invokeCore(event, op, { groupId, subscriptionId: state.subscriptionId, epoch: state.epoch });
      state.opening = false;
      if (!state.active) cancelNativeSubscription(state);
      return state.active;
    } catch (error) {
      state.opening = false;
      if (state.active) disposeSubscription(state);
      else cancelNativeSubscription(state);
      throw error;
    }
  };

  const unsubscribe = (event: IpcMainInvokeEvent, groupValue: unknown, kind: SubscriptionKind): void => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireText(groupValue, 36, 'Grupo');
    const state = activeSubscriptions.get(subscriptionKey(event.sender.id, kind, groupId));
    if (state) disposeSubscription(state);
  };

  const sendError = (state: SubscriptionState, payload: unknown): void => {
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? payload.message.slice(0, 2_048)
      : 'A inscrição em tempo real falhou.';
    const channel = state.kind === 'members' ? 'cloud:members-error'
      : state.kind === 'presence' ? 'cloud:presence-error' : 'signals:error';
    state.frame.send(channel, { groupId: state.groupId, message });
  };

  const handleCoreEvent = (eventJson: string): void => {
    const event = parseCoreEvent(eventJson);
    const state = subscriptionsById.get(event.subscriptionId);
    if (!state || !state.active || state.epoch !== event.epoch) return;
    if (state.sender.isDestroyed() || state.frame !== state.sender.mainFrame
      || BrowserWindow.fromWebContents(state.sender) !== getMainWindow()) {
      disposeSubscription(state);
      return;
    }
    if (event.kind === 'error') {
      sendError(state, event.payload);
      return;
    }
    if (event.kind === 'members' && state.kind === 'members' && Array.isArray(event.payload)) {
      state.frame.send('cloud:members-update', { groupId: state.groupId, members: event.payload });
      return;
    }
    if (event.kind === 'presence' && state.kind === 'presence' && isRecord(event.payload)
      && isRecord(event.payload.presence) && typeof event.payload.ready === 'boolean') {
      const presence: Record<string, 'online' | 'away'> = {};
      for (const [userId, status] of Object.entries(event.payload.presence)) {
        if (status !== 'online' && status !== 'away') {
          sendError(state, { message: 'A presença recebida é inválida.' });
          return;
        }
        presence[userId] = status;
      }
      state.frame.send('cloud:presence-update', { groupId: state.groupId, presence, ready: event.payload.ready });
      return;
    }
    if (event.kind === 'signal' && state.kind === 'signals' && isRecord(event.payload)
      && typeof event.payload.senderId === 'string' && typeof event.payload.kind === 'string') {
      state.frame.send('signals:received', {
        groupId: state.groupId,
        senderId: event.payload.senderId,
        envelope: event.payload,
      });
    }
  };

  ipcMain.handle('cloud:get-status', (event) => invokeCore(event, 'getCloudStatus', {}));
  ipcMain.handle('cloud:refresh', (event) => invokeCore(event, 'refreshCloud', {}));
  ipcMain.handle('identity:get-public', (event) => invokeCore(event, 'getPublicIdentity', {}));
  ipcMain.handle('identity:sign', (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const request = recordInput(input, 'Dados de assinatura');
    return invokeCore(event, 'signIdentityPayload', { payloadBase64: identityPayloadBase64(request.payload) });
  });
  ipcMain.handle('identity:verify', (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const request = recordInput(input, 'Dados de verificação');
    return invokeCore(event, 'verifyIdentityPayload', {
      payloadBase64: identityPayloadBase64(request.payload),
      signature: request.signature,
      publicKey: request.publicKey,
    });
  });

  ipcMain.handle('cloud:create-group', (event, name: unknown) => invokeCore(event, 'createCloudGroup', { name }));
  ipcMain.handle('cloud:create-invite', (event, groupId: unknown) => invokeCore(event, 'createCloudInvite', { groupId }));
  ipcMain.handle('cloud:list-invites', (event, groupId: unknown) => invokeCore(event, 'listCloudInvites', { groupId }));
  ipcMain.handle('cloud:accept-invite', (event, code: unknown) => invokeCore(event, 'acceptCloudInvite', { code }));
  ipcMain.handle('cloud:revoke-invite', (event, input: unknown) => {
    const request = recordInput(input, 'Dados do convite');
    return invokeCore(event, 'revokeCloudInvite', { groupId: request.groupId, inviteId: request.inviteId });
  });
  ipcMain.handle('cloud:remove-member', (event, input: unknown) => {
    const request = recordInput(input, 'Dados do participante');
    return invokeCore(event, 'removeCloudMember', { groupId: request.groupId, memberUserId: request.memberUserId });
  });
  ipcMain.handle('cloud:leave-group', (event, groupId: unknown) => invokeCore(event, 'leaveCloudGroup', { groupId }));
  ipcMain.handle('cloud:get-members', (event, groupId: unknown) => invokeCore(event, 'getCloudMembers', { groupId }));
  ipcMain.handle('profile:get', (event) => invokeCore(event, 'getMyProfile', {}));
  ipcMain.handle('profile:save', (event, input: unknown) => invokeCore(event, 'saveMyProfile', input));
  ipcMain.handle('cloud:subscribe-members', (event, groupId: unknown) => subscribe(event, groupId, 'members', 'subscribeCloudMembers'));
  ipcMain.handle('cloud:unsubscribe-members', (event, groupId: unknown) => unsubscribe(event, groupId, 'members'));
  ipcMain.handle('cloud:subscribe-presence', (event, groupId: unknown) => subscribe(event, groupId, 'presence', 'subscribeCloudPresence'));
  ipcMain.handle('cloud:unsubscribe-presence', (event, groupId: unknown) => unsubscribe(event, groupId, 'presence'));
  ipcMain.handle('cloud:get-turn-servers', (event, groupId: unknown) => invokeCore(event, 'getTurnServers', { groupId }));
  ipcMain.handle('cloud:get-cache', (event) => invokeCore(event, 'getCachedCloudGroups', {}));
  ipcMain.handle('cloud:get-cached-members', (event, groupId: unknown) => invokeCore(event, 'getCachedCloudMembers', { groupId }));

  ipcMain.handle('screen-share:acquire', (event, groupId: unknown) => invokeCore(event, 'acquireScreenShare', { groupId }));
  ipcMain.handle('screen-share:release', (event, groupId: unknown) => invokeCore(event, 'releaseScreenShare', { groupId }));

  ipcMain.handle('messages:read-cached', (event, input: unknown) => {
    const request = recordInput(input, 'Consulta de histórico');
    return invokeCore(event, 'getCachedMessages', { groupId: request.groupId, perAuthorLimit: request.perAuthorLimit });
  });
  ipcMain.handle('messages:persist-outgoing', (event, message: unknown) => invokeCore(event, 'persistOutgoingEnvelope', { message }));
  ipcMain.handle('messages:persist-verified', (event, message: unknown) => invokeCore(event, 'persistVerifiedEnvelope', { message }));
  ipcMain.handle('messages:read-missing', (event, input: unknown) => {
    const request = recordInput(input, 'Faixa de mensagens');
    return invokeCore(event, 'readMissingEnvelopes', {
      groupId: request.groupId,
      authorId: request.authorId,
      afterSequence: request.afterSequence,
      throughSequence: request.throughSequence,
      limit: request.limit,
    });
  });
  ipcMain.handle('messages:persist-ack', (event, acknowledgement: unknown) => invokeCore(event, 'persistMessageAcknowledgement', { acknowledgement }));
  ipcMain.handle('messages:get-highest', (event, input: unknown) => {
    const request = recordInput(input, 'Consulta de sequência');
    return invokeCore(event, 'getHighestContiguousSequence', { groupId: request.groupId, authorId: request.authorId });
  });
  ipcMain.handle('messages:read-recent', (event, input: unknown) => {
    const request = recordInput(input, 'Consulta de histórico');
    return invokeCore(event, 'getRecentMessages', { groupId: request.groupId, perAuthorLimit: request.perAuthorLimit });
  });

  ipcMain.handle('signals:send', (event, input: unknown) => {
    const request = recordInput(input, 'Sinalização');
    return invokeCore(event, 'sendSignal', { groupId: request.groupId, envelope: request.envelope });
  });
  ipcMain.handle('signals:subscribe', (event, groupId: unknown) => subscribe(event, groupId, 'signals', 'subscribeSignals'));
  ipcMain.handle('signals:unsubscribe', (event, groupId: unknown) => unsubscribe(event, groupId, 'signals'));

  ipcMain.handle('display:list-sources', async (event) => {
    assertTrustedFrame(event, getMainWindow());
    const sources = await listDesktopDisplaySources();
    assertTrustedFrame(event, getMainWindow());
    return sources;
  });
  ipcMain.handle('display:prepare', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const request = recordInput(input, 'A fonte da captura de tela');
    if (typeof request.includeSystemAudio !== 'boolean') throw new TypeError('A fonte da captura de tela é inválida.');
    await prepareDesktopDisplayCapture(event.sender.id, requireText(request.sourceId, 512, 'Fonte'), request.includeSystemAudio);
    try { assertTrustedFrame(event, getMainWindow()); } catch (error) {
      clearDesktopDisplayCapture(event.sender.id);
      throw error;
    }
  });
  ipcMain.handle('window:set-screen-viewer-expanded', (event, expanded: unknown) => {
    const window = getMainWindow();
    if (!window) throw new Error('Janela principal indisponível.');
    assertTrustedFrame(event, window);
    if (typeof expanded !== 'boolean') throw new TypeError('Estado da visualização de tela inválido.');
    if (expanded) {
      if (!screenViewerRestoreState.has(window)) {
        screenViewerRestoreState.set(window, { wasMaximized: window.isMaximized(), wasFullScreen: window.isFullScreen() });
      }
      if (window.isFullScreen()) window.setFullScreen(false);
      if (!window.isMaximized()) window.maximize();
      return;
    }
    const restoreState = screenViewerRestoreState.get(window);
    if (!restoreState) return;
    screenViewerRestoreState.delete(window);
    if (restoreState.wasFullScreen) window.setFullScreen(true);
    else if (!restoreState.wasMaximized && window.isMaximized()) window.unmaximize();
  });

  return handleCoreEvent;
}
