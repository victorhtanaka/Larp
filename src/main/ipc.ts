import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { GroupMember, IdentitySignature } from '../shared/cloud-contracts';
import { envelopeSigningBytes, parseProtocolEnvelope, validateProtocolEnvelope, MAX_SYNC_RANGE, MAX_SYNC_BATCH_MESSAGES, type SignedChatEnvelope, type SignedAckEnvelope } from '../shared/webrtc-protocol';
import type { LocalLarpDatabase } from './database';
import type { LarpRuntime } from './services/runtime';
import { profileUpdateFromIpc } from './profile-validation';
import { listDesktopDisplaySources, prepareDesktopDisplayCapture } from './display-capture';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_CODE = /^[A-Za-z0-9_-]{43}$/;



function requireSequence(value: unknown, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) throw new TypeError(`${label} inválida.`);
  return value as number;
}

function cloudIdentity(runtime: LarpRuntime): { userId: string } {
  const status = runtime.getCloudStatus();
  if (status.state !== 'ready' || !status.userId) throw new Error('A sessão de grupos não está disponível.');
  return { userId: requireUuid(status.userId, 'Usuário') };
}

function requireText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new TypeError(`${label} inválido.`);
  return value.trim();
}

function requireUuid(value: unknown, label: string): string {
  const uuid = requireText(value, 36, label);
  if (!UUID.test(uuid)) throw new TypeError(`${label} inválido.`);
  return uuid;
}
function assertTrustedFrame(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): void {
  if (!mainWindow || BrowserWindow.fromWebContents(event.sender) !== mainWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Origem IPC não autorizada.');
  }
}

export function registerIpcHandlers(
  database: LocalLarpDatabase,
  getMainWindow: () => BrowserWindow | null,
  runtime: LarpRuntime,
): void {
  const screenViewerRestoreState = new WeakMap<BrowserWindow, { wasMaximized: boolean; wasFullScreen: boolean }>();

  const refreshCloudAndCache = async () => {
    const status = await runtime.refreshCloud();
    if (status.state === 'ready') {
      const membersByGroup = new Map<string, GroupMember[]>();
      for (const group of status.groups) membersByGroup.set(group.id, await runtime.requireCloud().getMembers(group.id));
      database.replaceCloudCache(status.groups, membersByGroup);
    }
    return status;
  };

  ipcMain.handle('cloud:get-status', (event) => {
    assertTrustedFrame(event, getMainWindow());
    return runtime.getCloudStatus();
  });
  ipcMain.handle('profile:get', (event) => {
    assertTrustedFrame(event, getMainWindow());
    return runtime.getCloudStatus().state === 'ready' ? runtime.requireCloud().getMyProfile() : null;
  });
  ipcMain.handle('profile:save', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (runtime.getCloudStatus().state !== 'ready') throw new Error('A conexão necessária para salvar o perfil não está disponível.');
    const profile = await runtime.requireCloud().saveMyProfile(profileUpdateFromIpc(input));
    for (const group of runtime.getCloudStatus().groups) {
      const members = database.getCachedCloudMembers(group.id);
      if (members.some((member) => member.userId === profile.userId)) {
        database.cacheCloudMembers(group.id, members.map((member) => member.userId === profile.userId
          ? { ...member, profile }
          : member));
      }
    }
    return profile;
  });
  ipcMain.handle('display:list-sources', async (event) => {
    assertTrustedFrame(event, getMainWindow());
    return listDesktopDisplaySources();
  });
  ipcMain.handle('display:prepare', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || !('sourceId' in input) || !('includeSystemAudio' in input)
      || typeof input.includeSystemAudio !== 'boolean') {
      throw new TypeError('A fonte da captura de tela é inválida.');
    }
    await prepareDesktopDisplayCapture(event.sender.id, requireText(input.sourceId, 512, 'Fonte'), input.includeSystemAudio);
  });
  ipcMain.handle('window:set-screen-viewer-expanded', (event, expanded: unknown) => {
    const window = getMainWindow();
    if (!window) throw new Error('Janela principal indisponível.');
    assertTrustedFrame(event, window);
    if (typeof expanded !== 'boolean') throw new TypeError('Estado da visualização de tela inválido.');

    if (expanded) {
      if (!screenViewerRestoreState.has(window)) {
        screenViewerRestoreState.set(window, {
          wasMaximized: window.isMaximized(),
          wasFullScreen: window.isFullScreen(),
        });
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

  ipcMain.handle('screen-share:acquire', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    cloudIdentity(runtime);
    return runtime.requireCloud().acquireShareLease(groupId);
  });
  ipcMain.handle('screen-share:release', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    cloudIdentity(runtime);
    await runtime.requireCloud().releaseShareLease(groupId);
  });

  ipcMain.handle('cloud:get-turn-servers', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    cloudIdentity(runtime);
    return runtime.requireCloud().getTurnServers(groupId);
  });
  ipcMain.handle('cloud:refresh', async (event) => {
    assertTrustedFrame(event, getMainWindow());
    return refreshCloudAndCache();
  });

  ipcMain.handle('identity:get-public', (event) => {
    assertTrustedFrame(event, getMainWindow());
    if (!runtime.publicIdentity) throw new Error(runtime.getCloudStatus().detail);
    return runtime.publicIdentity;
  });

  ipcMain.handle('identity:sign', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('payload' in input)) {
      throw new TypeError('Dados de assinatura inválidos.');
    }
    const payload = input.payload;
    if (typeof payload !== 'string' || payload.length === 0 || Buffer.byteLength(payload, 'utf8') > 65_536) {
      throw new TypeError('Conteúdo para assinatura inválido.');
    }
    if (!runtime.identity) throw new Error('A identidade protegida não está disponível.');
    return runtime.identity.sign(payload);
  });

  ipcMain.handle('identity:verify', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('payload' in input)
      || !('signature' in input) || !('publicKey' in input)) {
      throw new TypeError('Dados de verificação inválidos.');
    }
    const payload = input.payload;
    if (typeof payload !== 'string' || payload.length === 0 || Buffer.byteLength(payload, 'utf8') > 65_536) {
      throw new TypeError('Conteúdo para verificação inválido.');
    }
    const publicKey = requireText(input.publicKey, 4096, 'Chave pública');
    const rawSignature = input.signature;
    if (!rawSignature || typeof rawSignature !== 'object' || Array.isArray(rawSignature)
      || !('algorithm' in rawSignature) || !('signature' in rawSignature)
      || rawSignature.algorithm !== 'Ed25519' || typeof rawSignature.signature !== 'string' || rawSignature.signature.length > 256) {
      throw new TypeError('Assinatura inválida.');
    }
    const signature: IdentitySignature = { algorithm: rawSignature.algorithm, signature: rawSignature.signature };
    if (!runtime.identity) throw new Error('A identidade protegida não está disponível.');
    return runtime.identity.verify(payload, signature, publicKey);
  });

  ipcMain.handle('cloud:create-group', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const name = requireText(input, 80, 'Nome do grupo');
    const group = await runtime.requireCloud().createGroup(name);
    await refreshCloudAndCache();
    return group;
  });

  ipcMain.handle('cloud:create-invite', (event, groupId: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    return runtime.requireCloud().createInvite(requireUuid(groupId, 'Grupo'));
  });

  ipcMain.handle('cloud:accept-invite', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const code = requireText(input, 43, 'Convite');
    if (!INVITE_CODE.test(code)) throw new TypeError('Código de convite inválido.');
    const group = await runtime.requireCloud().acceptInvite(code);
    await refreshCloudAndCache();
    return group;
  });

  ipcMain.handle('cloud:revoke-invite', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('groupId' in input) || !('inviteId' in input)) {
      throw new TypeError('Dados do convite inválidos.');
    }
    await runtime.requireCloud().revokeInvite(
      requireUuid(input.groupId, 'Grupo'),
      requireUuid(input.inviteId, 'Convite'),
    );
  });

  ipcMain.handle('cloud:remove-member', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !('groupId' in input) || !('memberUserId' in input)) {
      throw new TypeError('Dados do participante inválidos.');
    }
    await runtime.requireCloud().removeMember(
      requireUuid(input.groupId, 'Grupo'),
      requireUuid(input.memberUserId, 'Participante'),
    );
    await refreshCloudAndCache();
  });
  ipcMain.handle('cloud:get-members', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    const members = await runtime.requireCloud().getMembers(groupId);
    database.cacheCloudMembers(groupId, members);
    return members;
  });
  ipcMain.handle('cloud:subscribe-members', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    const sender = event.sender;
    membershipSubscriptions.get(sender.id)?.get(groupId)?.dispose();
    const disposeCloud = await runtime.requireCloud().subscribeRealtimeMembers(
      groupId,
      (members) => {
        if (sender.isDestroyed() || BrowserWindow.fromWebContents(sender) !== getMainWindow()) return;
        database.cacheCloudMembers(groupId, members);
        sender.send('cloud:members-update', { groupId, members });
      },
      (message) => {
        if (!sender.isDestroyed() && BrowserWindow.fromWebContents(sender) === getMainWindow()) {
          sender.send('cloud:members-error', { groupId, message });
        }
      },
    );
    const dispose = () => {
      void disposeCloud();
      sender.removeListener('destroyed', dispose);
      const subscriptions = membershipSubscriptions.get(sender.id);
      if (subscriptions?.get(groupId)?.dispose === dispose) {
        subscriptions.delete(groupId);
        if (subscriptions.size === 0) membershipSubscriptions.delete(sender.id);
      }
    };
    const subscriptions = membershipSubscriptions.get(sender.id) ?? new Map<string, { dispose: () => void }>();
    subscriptions.set(groupId, { dispose });
    membershipSubscriptions.set(sender.id, subscriptions);
    sender.once('destroyed', dispose);
    return true;
  });
  ipcMain.handle('cloud:unsubscribe-members', (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    membershipSubscriptions.get(event.sender.id)?.get(groupId)?.dispose();
  });
  ipcMain.handle('cloud:get-cache', (event) => {
    assertTrustedFrame(event, getMainWindow());
    return database.getCachedCloudGroups();
  });
  ipcMain.handle('cloud:get-cached-members', (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    return database.getCachedCloudMembers(requireUuid(groupValue, 'Grupo'));
  });
 
  const messageStores = new Map<string, ReturnType<LocalLarpDatabase['createMessageStore']>>();
  const signalSubscriptions = new Map<number, { groupId: string; dispose: () => void }>();
  const membershipSubscriptions = new Map<number, Map<string, { dispose: () => void }>>();
  const getStore = (userId: string) => {
    let store = messageStores.get(userId);
    if (!store) {
      store = database.createMessageStore(userId);
      messageStores.set(userId, store);
    }
    return store;
  };
  const getMemberKey = async (groupId: string, userId: string): Promise<string | undefined> => {
    const members = await runtime.requireCloud().getMembers(groupId);
    return members.find((member) => member.userId === userId)?.publicKey;
  };
  const verifyMemberEnvelope = async (envelope: SignedChatEnvelope | SignedAckEnvelope, groupId: string, senderId: string) => {
    const key = await getMemberKey(groupId, senderId);
    if (!key || !runtime.identity || !await runtime.identity.verify(envelopeSigningBytes(envelope), envelope.signature, key)) {
      throw new Error('Assinatura ou remetente do envelope inválido.');
    }
  };
  ipcMain.handle('cloud:list-invites', (event, groupId: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    return runtime.requireCloud().listInvites(requireUuid(groupId, 'Grupo'));
  });
  ipcMain.handle('cloud:leave-group', async (event, groupId: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const result = await runtime.requireCloud().leaveGroup(requireUuid(groupId, 'Grupo'));
    await refreshCloudAndCache();
    return result;
  });
  ipcMain.handle('messages:persist-outgoing', async (event, raw: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const parsed = validateProtocolEnvelope(raw);
    if (!parsed.ok || parsed.envelope.kind !== 'chat') throw new TypeError('Envelope de mensagem inválido.');
    const { envelope } = parsed;
    requireUuid(envelope.groupId, 'Grupo');
    requireUuid(envelope.senderId, 'Remetente');
    const { userId } = cloudIdentity(runtime);
    if (envelope.senderId !== userId) throw new Error('A mensagem não pertence ao usuário local.');
    await verifyMemberEnvelope(envelope, envelope.groupId, userId);
    await getStore(userId).persistBeforeSend(envelope);
  });
  ipcMain.handle('messages:persist-verified', async (event, raw: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const parsed = validateProtocolEnvelope(raw);
    if (!parsed.ok || parsed.envelope.kind !== 'chat') throw new TypeError('Envelope de mensagem inválido.');
    const { envelope } = parsed;
    requireUuid(envelope.groupId, 'Grupo');
    requireUuid(envelope.senderId, 'Remetente');
    const { userId } = cloudIdentity(runtime);
    await verifyMemberEnvelope(envelope, envelope.groupId, envelope.senderId);
    return getStore(userId).persistVerifiedIncoming(envelope);
  });
  ipcMain.handle('messages:persist-ack', async (event, raw: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const parsed = validateProtocolEnvelope(raw);
    if (!parsed.ok || parsed.envelope.kind !== 'ack') throw new TypeError('Confirmação inválida.');
    const { envelope } = parsed;
    requireUuid(envelope.groupId, 'Grupo');
    requireUuid(envelope.senderId, 'Remetente');
    const { userId } = cloudIdentity(runtime);
    await verifyMemberEnvelope(envelope, envelope.groupId, envelope.senderId);
    await getStore(userId).persistRecipientAck(envelope);
  });
  ipcMain.handle('messages:read-missing', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('groupId' in input) || !('authorId' in input) || !('afterSequence' in input) || !('throughSequence' in input) || !('limit' in input)) throw new TypeError('Faixa inválida.');
    const groupId = requireUuid(input.groupId, 'Grupo');
    const authorId = requireUuid(input.authorId, 'Autor');
    const after = requireSequence(input.afterSequence, 'Sequência', true);
    const through = requireSequence(input.throughSequence, 'Sequência', true);
    const limit = requireSequence(input.limit, 'Limite');
    if (through < after || through - after > MAX_SYNC_RANGE || limit > MAX_SYNC_BATCH_MESSAGES) throw new TypeError('Faixa inválida.');
    const { userId } = cloudIdentity(runtime);
    if (!await getMemberKey(groupId, userId) || !await getMemberKey(groupId, authorId)) throw new Error('Membro do grupo inválido.');
    return getStore(userId).readMissing(groupId, authorId, after, through, limit);
  });
  ipcMain.handle('messages:get-highest', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('groupId' in input) || !('authorId' in input)) throw new TypeError('Consulta inválida.');
    const groupId = requireUuid(input.groupId, 'Grupo');
    const authorId = requireUuid(input.authorId, 'Autor');
    const { userId } = cloudIdentity(runtime);
    if (!await getMemberKey(groupId, userId) || !await getMemberKey(groupId, authorId)) throw new Error('Membro do grupo inválido.');
    return getStore(userId).getHighestContiguousSequence(groupId, authorId);
  });
  ipcMain.handle('messages:read-recent', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('groupId' in input)) {
      throw new TypeError('Consulta de histórico inválida.');
    }
    const request = input as Record<string, unknown>;
    const groupId = requireUuid(request.groupId, 'Grupo');
    const perAuthorLimit = request.perAuthorLimit === undefined ? 100 : requireSequence(request.perAuthorLimit, 'Limite');
    if (perAuthorLimit > 100) throw new TypeError('O limite de histórico deve ser de até 100 mensagens por participante.');
    const { userId } = cloudIdentity(runtime);
    const members = await runtime.requireCloud().getMembers(groupId);
    if (!members.some((member) => member.userId === userId)) throw new Error('O usuário não pertence a este grupo.');
    const store = getStore(userId);
    const messages: SignedChatEnvelope[] = [];
    for (const member of members) {
      const throughSequence = await store.getHighestContiguousSequence(groupId, member.userId);
      let afterSequence = Math.max(0, throughSequence - perAuthorLimit);
      while (afterSequence < throughSequence) {
        const batch = await store.readMissing(groupId, member.userId, afterSequence, throughSequence, MAX_SYNC_BATCH_MESSAGES);
        if (!batch.length) break;
        for (const message of batch) {
          if (message.senderId !== member.userId || !runtime.identity
            || !await runtime.identity.verify(envelopeSigningBytes(message), message.signature, member.publicKey)) {
            throw new Error('A assinatura do histórico local não é válida.');
          }
        }
        messages.push(...batch);
        afterSequence = batch[batch.length - 1].sequence;
      }
    }
    return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });
  ipcMain.handle('messages:read-cached', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('groupId' in input)) {
      throw new TypeError('Consulta de histórico em cache inválida.');
    }
    const request = input as Record<string, unknown>;
    const groupId = requireUuid(request.groupId, 'Grupo');
    const perAuthorLimit = request.perAuthorLimit === undefined ? 100 : requireSequence(request.perAuthorLimit, 'Limite');
    if (perAuthorLimit > 100) throw new TypeError('O limite de histórico deve ser de até 100 mensagens por participante.');
    const members = database.getCachedCloudMembers(groupId);
    if (members.length === 0) throw new Error('Não há metadados locais para verificar este grupo.');
    if (!runtime.identity) throw new Error('A identidade protegida não está disponível.');
    const messages = await database.getCachedMessages(groupId, perAuthorLimit);
    for (const message of messages) {
      const member = members.find((candidate) => candidate.userId === message.senderId);
      if (!member || !await runtime.identity.verify(envelopeSigningBytes(message), message.signature, member.publicKey)) {
        throw new Error('A assinatura do histórico local não é válida.');
      }
    }
    return messages;
  });
  ipcMain.handle('signals:send', async (event, input: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('groupId' in input) || !('envelope' in input)) throw new TypeError('Sinalização inválida.');
    const request = input as Record<string, unknown>;
    const groupId = requireUuid(request.groupId, 'Grupo');
    const parsed = validateProtocolEnvelope(request.envelope);
    if (!parsed.ok || parsed.envelope.groupId !== groupId
      || !['description', 'ice-batch', 'connect-request', 'protocol-error'].includes(parsed.envelope.kind)
      || !('recipientId' in parsed.envelope)) throw new TypeError('Sinalização inválida.');
    const envelope = parsed.envelope;
    requireUuid(envelope.groupId, 'Grupo');
    requireUuid(envelope.senderId, 'Remetente');
    requireUuid(envelope.recipientId, 'Destinatário');
    const { userId } = cloudIdentity(runtime);
    if (envelope.senderId !== userId || !await getMemberKey(groupId, envelope.recipientId)) throw new Error('Destinatário ou remetente inválido.');
    const senderKey = await getMemberKey(groupId, userId);
    if (!senderKey || !runtime.identity || !await runtime.identity.verify(envelopeSigningBytes(envelope), envelope.signature, senderKey)) throw new Error('Assinatura inválida.');
    await runtime.requireCloud().sendRealtimeSignal(groupId, envelope);
  });
  ipcMain.handle('signals:subscribe', async (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    const { userId } = cloudIdentity(runtime);
    const sender = event.sender;
    const prior = signalSubscriptions.get(sender.id);
    if (prior) prior.dispose();
    const disposeCloud = await runtime.requireCloud().subscribeRealtimeSignals(groupId, async (senderId, raw) => {
      try {
        const parsed = parseProtocolEnvelope(JSON.stringify(raw));
        if (!parsed.ok) return;
        const envelope = parsed.envelope;
        if (senderId !== envelope.senderId || envelope.groupId !== groupId || !('recipientId' in envelope) || envelope.recipientId !== userId) return;
        requireUuid(envelope.groupId, 'Grupo');
        requireUuid(envelope.senderId, 'Remetente');
        requireUuid(envelope.recipientId, 'Destinatário');
        const key = await getMemberKey(groupId, envelope.senderId);
        if (!key || !runtime.identity || !await runtime.identity.verify(envelopeSigningBytes(envelope), envelope.signature, key)) return;
        if (BrowserWindow.fromWebContents(sender) === getMainWindow() && !sender.isDestroyed()) {
          sender.send('signals:received', { groupId, senderId: envelope.senderId, envelope });
        }
      } catch { /* Ignore unauthenticated realtime payloads. */ }
    });
    const dispose = () => {
      disposeCloud();
      if (signalSubscriptions.get(sender.id)?.dispose === dispose) signalSubscriptions.delete(sender.id);
    };
    signalSubscriptions.set(sender.id, { groupId, dispose });
    sender.once('destroyed', dispose);
    return true;
  });
  ipcMain.handle('signals:unsubscribe', (event, groupValue: unknown) => {
    assertTrustedFrame(event, getMainWindow());
    const groupId = requireUuid(groupValue, 'Grupo');
    const subscription = signalSubscriptions.get(event.sender.id);
    if (subscription?.groupId === groupId) subscription.dispose();
  });
}
