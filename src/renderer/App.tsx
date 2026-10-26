import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import type { ChatMessage, SelectedDisplaySource, TurnCredentialServer } from '../shared/contracts';
import type { CloudConnectionStatus, GroupInvite, GroupInviteSummary, GroupMember, GroupSummary, PublicIdentity } from '../shared/cloud-contracts';
import type { SignedChatEnvelope } from '../shared/webrtc-protocol';
import { createGroupPeerMesh } from './rtc/create-peer-mesh';
import type { PeerMesh, PeerConnectionStatus } from './rtc/peer-mesh';
import type { PeerMediaStats } from './media/quality';
import { useMediaController } from './media/use-media-controller';
const INITIAL_CLOUD_STATUS: CloudConnectionStatus = {
  state: 'connecting',
  detail: 'Verificando a configuração de grupos…',
  groups: [],
};

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
    : fallback;
}

type IconName = 'bubble' | 'grid' | 'plus' | 'arrow' | 'info' | 'lock' | 'send' | 'mic' | 'headphones' | 'screen' | 'users' | 'close' | 'chevron' | 'spark';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    bubble: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 2 1-4.5A7.5 7.5 0 1 1 20 11.5Z" /><path d="M7 11h.01M12 11h.01M17 11h.01" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
    send: <><path d="m21 3-7.2 18-3.8-7-7-3.8L21 3Z" /><path d="M10 14 21 3" /></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" /></>,
    headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3" /><rect x="3" y="13" width="4" height="7" rx="2" /><rect x="17" y="13" width="4" height="7" rx="2" /></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z" /></>,
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {shapes[name]}
    </svg>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function Message({ message, localParticipantId }: { message: ChatMessage; localParticipantId?: string }) {
  const isLocal = message.authorId === localParticipantId;
  return (
    <article className={`message ${isLocal ? 'message-local' : ''}`}>
      <div className={`avatar ${isLocal ? 'avatar-local' : ''}`} aria-hidden="true">{message.authorInitials}</div>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{message.authorName}</span>
          <span className={`message-origin ${isLocal ? 'origin-local' : ''}`}>{isLocal ? 'Este PC' : 'P2P assinado'}</span>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>
        <p>{message.content}</p>
      </div>
    </article>
  );
}

function toPeerChatMessage(message: SignedChatEnvelope, localParticipantId?: string): ChatMessage {
  const isLocal = message.senderId === localParticipantId;
  return {
    id: message.messageId,
    groupId: message.groupId,
    authorId: message.senderId,
    authorName: isLocal ? 'Este computador' : `PC · ${message.senderId.slice(-6).toUpperCase()}`,
    authorInitials: isLocal ? 'PC' : message.senderId.slice(-2).toUpperCase(),
    content: message.content,
    sequence: message.sequence,
    createdAt: message.createdAt,
  };
}

function describePeerMediaStats(stats: PeerMediaStats): string {
  const resolution = stats.resolution.value ? `${stats.resolution.value.width}×${stats.resolution.value.height}` : 'resolução indisponível';
  const fps = stats.framesPerSecond.value === null ? 'FPS indisponível' : `${Math.round(stats.framesPerSecond.value)} FPS`;
  const codec = stats.codec.value?.replace(/^video\//u, '') ?? 'codec indisponível';
  const bitrate = stats.uploadBitrate.value === null
    ? 'upload indisponível'
    : `${(stats.uploadBitrate.value / 1_000_000).toFixed(1)} Mb/s`;
  const path = stats.path.value?.localCandidateType === 'relay' || stats.path.value?.remoteCandidateType === 'relay'
    ? 'TURN'
    : stats.path.source === 'measured' ? 'direto' : 'caminho indisponível';
  return `${resolution} · ${fps} · ${codec} · ${bitrate} · ${path}`;
}

function App() {
  const [cloudStatus, setCloudStatus] = useState(INITIAL_CLOUD_STATUS);
  const [cachedCloudGroups, setCachedCloudGroups] = useState<GroupSummary[]>([]);
  const [cachedGroupsLoaded, setCachedGroupsLoaded] = useState(false);
  const [cachedCloudMembers, setCachedCloudMembers] = useState<GroupMember[]>([]);
  const [cachedMessages, setCachedMessages] = useState<ChatMessage[]>([]);
  const [cachedHistoryLoading, setCachedHistoryLoading] = useState(false);
  const [cachedHistoryError, setCachedHistoryError] = useState('');
  const [cloudGroupId, setCloudGroupId] = useState<string>();
  const [cloudMembers, setCloudMembers] = useState<GroupMember[]>([]);
  const [memberGroupId, setMemberGroupId] = useState<string>();
  const [cloudMessages, setCloudMessages] = useState<ChatMessage[]>([]);
  const [cloudMessagesGroupId, setCloudMessagesGroupId] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [peerStates, setPeerStates] = useState<Record<string, PeerConnectionStatus>>({});
  const [meshReady, setMeshReady] = useState(false);
  const [meshRetryNonce, setMeshRetryNonce] = useState(0);
  const [turnStatus, setTurnStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [peerError, setPeerError] = useState('');
  const meshRef = useRef<PeerMesh | null>(null);
  const persistedCloudMessageIds = useRef(new Set<string>());
  const [memberLoading, setMemberLoading] = useState(false);
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [draft, setDraft] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [joinInviteCode, setJoinInviteCode] = useState('');
  const [createdInvite, setCreatedInvite] = useState<GroupInvite | null>(null);
  const [inviteSummaries, setInviteSummaries] = useState<GroupInviteSummary[]>([]);
  const [cloudAction, setCloudAction] = useState('');
  const [cloudError, setCloudError] = useState('');
  const [cloudNotice, setCloudNotice] = useState('');

  const [sending, setSending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'connection' | 'groups' | 'audio' | 'screen'>('connection');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const offlineMode = cloudStatus.state === 'unavailable' || cloudStatus.state === 'not-configured';
  const listedCloudGroups = cloudStatus.state === 'ready'
    ? cloudStatus.groups
    : offlineMode ? cachedCloudGroups : [];
  const selectedCloudGroupId = listedCloudGroups.some((group) => group.id === cloudGroupId)
    ? cloudGroupId
    : listedCloudGroups[0]?.id;
  const activeCloudGroup = cloudStatus.state === 'ready'
    ? cloudStatus.groups.find((group) => group.id === selectedCloudGroupId)
    : undefined;
  const localCloudUserId = cloudStatus.state === 'ready' ? cloudStatus.userId : undefined;
  const cachedCloudGroup = offlineMode
    ? cachedCloudGroups.find((group) => group.id === selectedCloudGroupId)
    : undefined;
  const displayCloudGroup = activeCloudGroup ?? cachedCloudGroup;
  const activeGroup = displayCloudGroup;


  const openHelp = (event: MouseEvent<HTMLButtonElement>) => {
    helpTriggerRef.current = event.currentTarget;
    setDialogMode('connection');
    setHelpOpen(true);
  };
  const openGroupManager = (event: MouseEvent<HTMLButtonElement>) => {
    helpTriggerRef.current = event.currentTarget;
    setDialogMode('groups');
    setCloudError('');
    setCloudNotice('');
    setHelpOpen(true);
  };
  const closeHelp = () => {
    if (dialogMode === 'audio' && media.microphoneTestActive) void media.stopMicrophoneTest();
    setHelpOpen(false);
    requestAnimationFrame(() => helpTriggerRef.current?.focus());
  };

  const openAudioSettings = (event?: MouseEvent<HTMLButtonElement>) => {
    if (event) helpTriggerRef.current = event.currentTarget;
    setDialogMode('audio');
    setHelpOpen(true);
    void media.refreshAudioDevices(false);
  };

  const openScreenSettings = (event?: MouseEvent<HTMLButtonElement>) => {
    if (event) helpTriggerRef.current = event.currentTarget;
    if (!activeCloudGroup || !meshReady || !media.mediaReady) {
      setPeerError('Conecte-se a um grupo privado antes de compartilhar a tela.');
      return;
    }
    setDialogMode('screen');
    setHelpOpen(true);
    void media.refreshDisplaySources();
  };

  useEffect(() => {
    void window.larp.refreshCloud()
      .then(setCloudStatus)
      .catch((cause: unknown) => setCloudError(describeError(cause, 'Não foi possível atualizar os grupos.')));
    void window.larp.getPublicIdentity().then(setIdentity).catch(() => setIdentity(null));
  }, []);


  useEffect(() => {
    let current = true;
    setCachedGroupsLoaded(false);
    void window.larp.getCachedCloudGroups()
      .then((groups) => {
        if (!current) return;
        setCachedCloudGroups(groups);
        setCachedGroupsLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setCloudError(describeError(cause, 'Não foi possível ler os grupos salvos neste computador.'));
        setCachedGroupsLoaded(true);
      });
    return () => { current = false; };
  }, [cloudStatus]);


  useEffect(() => {
    const groupId = activeCloudGroup?.id;
    if (!groupId) {
      setCloudMembers([]);
      setMemberGroupId(undefined);
      setMemberLoading(false);
      return;
    }
    let current = true;
    let initialSnapshot = true;
    setCloudMembers([]);
    setMemberGroupId(undefined);
    setMemberLoading(true);
    const unsubscribe = window.larp.subscribeCloudMembers(
      groupId,
      (members) => {
        if (!current) return;
        if (!members.some((member) => member.userId === localCloudUserId)) {
          setCloudMembers([]);
          setMemberGroupId(undefined);
          setMemberLoading(false);
          void window.larp.refreshCloud().then(setCloudStatus).catch((cause: unknown) => {
            if (current) setCloudError(describeError(cause, 'Não foi possível atualizar o acesso ao grupo.'));
          });
          return;
        }
        setCloudMembers(members);
        setMemberGroupId(groupId);
        setMemberLoading(false);
        if (initialSnapshot) {
          initialSnapshot = false;
          return;
        }
        void window.larp.refreshCloud().then(setCloudStatus).catch((cause: unknown) => {
          if (current) setCloudError(describeError(cause, 'Não foi possível atualizar os grupos.'));
        });
      },
      (message) => {
        if (!current) return;
        initialSnapshot = false;
        setCloudError(describeError(new Error(message), 'A atualização dos participantes foi interrompida.'));
        void window.larp.getCloudMembers(groupId)
          .then((members) => {
            if (!current) return;
            if (!members.some((member) => member.userId === localCloudUserId)) {
              setCloudMembers([]);
              setMemberGroupId(undefined);
              void window.larp.refreshCloud().then(setCloudStatus).catch(() => undefined);
              return;
            }
            setCloudMembers(members);
            setMemberGroupId(groupId);
            setMemberLoading(false);
          })
          .catch((cause: unknown) => {
            if (!current) return;
            setMemberLoading(false);
            setCloudError(describeError(cause, 'Não foi possível carregar os participantes.'));
            void window.larp.refreshCloud().then(setCloudStatus).catch(() => undefined);
          });
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [activeCloudGroup?.id, localCloudUserId]);

  useEffect(() => {
    if (!cachedCloudGroup) {
      setCachedCloudMembers([]);
      setCachedMessages([]);
      setCachedHistoryLoading(false);
      setCachedHistoryError('');
      return;
    }
    const groupId = cachedCloudGroup.id;
    let current = true;
    setCachedCloudMembers([]);
    setCachedMessages([]);
    setCachedHistoryLoading(true);
    setCachedHistoryError('');
    void Promise.all([
      window.larp.getCachedCloudMembers(groupId),
      window.larp.getCachedMessages(groupId, 100),
    ])
      .then(([members, messages]) => {
        if (!current) return;
        setCachedCloudMembers(members);
        const localId = identity ? members.find((member) => member.publicKey === identity.publicKey)?.userId : undefined;
        setCachedMessages(messages.map((message) => toPeerChatMessage(message, localId)));
      })
      .catch((cause: unknown) => { if (current) setCachedHistoryError(describeError(cause, 'Não foi possível verificar o histórico local.')); })
      .finally(() => { if (current) setCachedHistoryLoading(false); });
    return () => { current = false; };
  }, [cachedCloudGroup?.id, identity?.publicKey]);

  useEffect(() => {
    if (!helpOpen || dialogMode !== 'groups' || !activeCloudGroup || activeCloudGroup.role !== 'owner') {
      setInviteSummaries([]);
      return;
    }
    const groupId = activeCloudGroup.id;
    let current = true;
    void window.larp.listCloudInvites(groupId)
      .then((invites) => { if (current) setInviteSummaries(invites); })
      .catch((cause: unknown) => { if (current) setCloudError(describeError(cause, 'Não foi possível carregar os convites ativos.')); });
    return () => { current = false; };
  }, [helpOpen, dialogMode, activeCloudGroup?.id, activeCloudGroup?.role]);

  const connectedPeerIds = useMemo(
    () => Object.entries(peerStates).filter(([, state]) => state === 'connected').map(([peerId]) => peerId),
    [peerStates],
  );
  const activeMesh = meshReady ? meshRef.current : null;
  const media = useMediaController({ groupId: activeCloudGroup?.id, mesh: activeMesh, connectedPeerIds });
  useEffect(() => {
    const group = activeCloudGroup;
    if (!group || !localCloudUserId || memberGroupId !== group.id || memberLoading) {
      meshRef.current?.close();
      meshRef.current = null;
      setMeshReady(false);
      setPeerStates({});
      setHistoryLoading(false);
      setTurnStatus('checking');
      if (group) {
        setCloudMessages([]);
        setCloudMessagesGroupId(group.id);
      } else {
        setCloudMessages([]);
        setCloudMessagesGroupId(undefined);
      }
      return;
    }
    let current = true;
    let mesh: PeerMesh | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    setMeshReady(false);
    setTurnStatus('checking');
    setPeerError('');
    setCloudMessages([]);
    setCloudMessagesGroupId(group.id);
    persistedCloudMessageIds.current.clear();
    setHistoryLoading(true);
    setPeerStates({});
    void window.larp.getRecentMessages(group.id, 100)
      .then((messages) => {
        if (!current) return;
        for (const message of messages) persistedCloudMessageIds.current.add(message.messageId);
        const history = messages.map((message) => toPeerChatMessage(message, localCloudUserId));
        setCloudMessages((previous) => {
          const historyIds = new Set(history.map((message) => message.id));
          return [...history, ...previous.filter((message) => !historyIds.has(message.id))]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        });
      })
      .catch((cause: unknown) => { if (current) setPeerError(describeError(cause, 'Não foi possível ler o histórico local.')); })
      .finally(() => { if (current) setHistoryLoading(false); });

    const startMesh = async () => {
      let turnServers: readonly TurnCredentialServer[] = [];
      try {
        const turnTimeout = new Promise<null>((resolve) => {
          turnTimer = setTimeout(() => resolve(null), 2_000);
        });
        const credentials = await Promise.race([window.larp.getTurnServers(group.id), turnTimeout]);
        clearTimeout(turnTimer);
        turnTimer = undefined;
        if (credentials === null) throw new Error('TURN credentials request timed out.');
        turnServers = credentials;
        setTurnStatus(credentials.length > 0 ? 'available' : 'unavailable');
      } catch {
        clearTimeout(turnTimer);
        turnTimer = undefined;
        if (!current) return;
        setTurnStatus('unavailable');
      }
      if (!current) return;
      try {
        mesh = createGroupPeerMesh({
          bridge: window.larp,
          groupId: group.id,
          localParticipantId: localCloudUserId,
          members: cloudMembers,
          turnServers,
          onMessage: (message) => {
            if (!current) return;
            persistedCloudMessageIds.current.add(message.messageId);
            const displayMessage = toPeerChatMessage(message, localCloudUserId);
            setCloudMessages((previous) => previous.some((item) => item.id === displayMessage.id)
              ? previous
              : [...previous, displayMessage].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
          },
          onPeerState: (peerId, state) => {
            if (current) setPeerStates((previous) => ({ ...previous, [peerId]: state }));
          },
          onTrack: media.handleRemoteTrack,
          onError: (message) => { if (current) setPeerError(message); },
        });
        meshRef.current = mesh;
        setMeshReady(true);
      } catch (cause) {
        setPeerError(describeError(cause, 'Não foi possível iniciar o chat P2P.'));
        setMeshReady(false);
      }
    };
    void startMesh();
    return () => {
      current = false;
      clearTimeout(turnTimer);
      mesh?.close();
      if (meshRef.current === mesh) meshRef.current = null;
    };
  }, [activeCloudGroup?.id, localCloudUserId, memberGroupId, memberLoading, cloudMembers, meshRetryNonce, media.handleRemoteTrack]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHelp();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.connection-dialog');
      const controls = dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!dialog || !controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    helpCloseRef.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen]);

  const selectCloudGroup = (groupId: string) => {
    setCloudGroupId(groupId);
    setCreatedInvite(null);
    setInviteSummaries([]);
    setNotice('');
    setDraft('');
    setError('');
  };



  const saveMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending || !activeCloudGroup || cloudStatus.state !== 'ready'
      || !meshReady || !meshRef.current || !localCloudUserId) return;
    setSending(true);
    setError('');
    setNotice('');
    let messageId: string | undefined;
    try {
      const highest = await window.larp.getHighestContiguousSequence(activeCloudGroup.id, localCloudUserId);
      if (highest >= Number.MAX_SAFE_INTEGER) throw new Error('A sequência de mensagens atingiu o limite suportado.');
      const sequence = highest + 1;
      messageId = crypto.randomUUID();
      await meshRef.current.sendMessage({ messageId, sequence, content });
      setDraft('');
      setNotice('Mensagem assinada e salva neste PC; aguardando confirmações P2P.');
    } catch (cause) {
      if (messageId && persistedCloudMessageIds.current.has(messageId)) {
        setDraft('');
        setNotice('Mensagem assinada e salva neste PC; a entrega será tentada quando houver conexão P2P.');
      } else {
        setError(describeError(cause, 'Não foi possível salvar ou transmitir a mensagem.'));
      }
    } finally {
      setSending(false);
    }
  };


  const refreshCloudStatus = async (): Promise<CloudConnectionStatus> => {
    setCloudAction('refresh');
    setCloudError('');
    try {
      const updated = await window.larp.refreshCloud();
      setCloudStatus(updated);
      if (updated.state === 'ready' && !updated.groups.some((group) => group.id === cloudGroupId)) {
        setCloudGroupId(updated.groups[0]?.id);
      }
      return updated;
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível atualizar os grupos.'));
      throw cause;
    } finally {
      setCloudAction('');
    }
  };
  const retryTurn = () => {
    setPeerError('');
    setTurnStatus('checking');
    setMeshRetryNonce((value) => value + 1);
  };

  const createCloudGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newGroupName.trim();
    if (name.length < 1 || name.length > 80 || cloudAction) return;
    setCloudAction('create');
    setCloudError('');
    setCloudNotice('');
    try {
      const group = await window.larp.createCloudGroup(name);
      const updated = await window.larp.getCloudStatus();
      setCloudStatus(updated);
      setCloudGroupId(group.id);
      setCreatedInvite(null);
      setInviteSummaries([]);
      setNewGroupName('');
      setCloudNotice(`Grupo “${group.name}” criado.`);
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível criar o grupo.'));
    } finally {
      setCloudAction('');
    }
  };

  const acceptCloudInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = joinInviteCode.trim();
    if (!code || cloudAction) return;
    setCloudAction('join');
    setCloudError('');
    setCloudNotice('');
    try {
      const group = await window.larp.acceptCloudInvite(code);
      setCloudStatus(await window.larp.getCloudStatus());
      setCloudGroupId(group.id);
      setCreatedInvite(null);
      setInviteSummaries([]);
      setJoinInviteCode('');
      setCloudNotice(`Você entrou em “${group.name}”.`);
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível aceitar o convite.'));
    } finally {
      setCloudAction('');
    }
  };

  const makeInvite = async () => {
    if (!activeCloudGroup || activeCloudGroup.role !== 'owner' || cloudAction || activeCloudGroup.memberCount >= 6) return;
    setCloudAction('invite');
    setCloudError('');
    setCloudNotice('');
    try {
      setCreatedInvite(await window.larp.createCloudInvite(activeCloudGroup.id));
      setInviteSummaries(await window.larp.listCloudInvites(activeCloudGroup.id));
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível criar o convite.'));
    } finally {
      setCloudAction('');
    }
  };

  const copyInvite = async () => {
    if (!createdInvite) return;
    try {
      await navigator.clipboard.writeText(createdInvite.code);
      setCloudNotice('Código de convite copiado.');
    } catch {
      setCloudError('Não foi possível acessar a área de transferência. Selecione e copie o código.');
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (!activeCloudGroup || activeCloudGroup.role !== 'owner' || cloudAction) return;
    setCloudAction('revoke');
    setCloudError('');
    try {
      await window.larp.revokeCloudInvite(activeCloudGroup.id, inviteId);
      setInviteSummaries((invites) => invites.filter((invite) => invite.id !== inviteId));
      setCreatedInvite((invite) => invite?.id === inviteId ? null : invite);
      setCloudNotice('Convite revogado.');
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível revogar o convite.'));
    } finally {
      setCloudAction('');
    }
  };

  const removeMember = async (member: GroupMember) => {
    if (cloudStatus.state !== 'ready' || !activeCloudGroup || activeCloudGroup.role !== 'owner' || member.userId === cloudStatus.userId || cloudAction) return;
    const label = `Participante ${member.userId.slice(0, 6).toUpperCase()}`;
    if (!window.confirm(`Remover ${label} do grupo “${activeCloudGroup.name}”?`)) return;
    setCloudAction('remove-member');
    setCloudError('');
    try {
      await window.larp.removeCloudMember(activeCloudGroup.id, member.userId);
      setCloudMembers((members) => members.filter((candidate) => candidate.userId !== member.userId));
      setCloudStatus(await window.larp.getCloudStatus());
      setCloudNotice(`${label} foi removido do grupo.`);
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível remover o participante.'));
    } finally {
      setCloudAction('');
    }
  };

  const leaveCloudGroup = async () => {
    if (!activeCloudGroup || cloudAction) return;
    const wasOwner = activeCloudGroup.role === 'owner';
    const confirmation = wasOwner
      ? `Sair de “${activeCloudGroup.name}”? A propriedade será transferida ao membro mais antigo. Se você for o último membro, o grupo será excluído.`
      : `Sair do grupo “${activeCloudGroup.name}”?`;
    if (!window.confirm(confirmation)) return;
    setCloudAction('leave');
    setCloudError('');
    try {
      const result = await window.larp.leaveCloudGroup(activeCloudGroup.id);
      const updated = await window.larp.getCloudStatus();
      setCloudStatus(updated);
      setCloudGroupId(updated.state === 'ready' ? updated.groups[0]?.id : undefined);
      setCloudMembers([]);
      setMemberGroupId(undefined);
      setCreatedInvite(null);
      setInviteSummaries([]);
      setCloudNotice(result.deleted ? `O grupo “${activeCloudGroup.name}” foi excluído.` : wasOwner ? 'Você saiu; a propriedade foi transferida.' : 'Você saiu do grupo.');
    } catch (cause) {
      setCloudError(describeError(cause, 'Não foi possível sair do grupo.'));
    } finally {
      setCloudAction('');
    }
  };
  const startSelectedScreenShare = async () => {
    const source: SelectedDisplaySource | undefined = media.displaySources.find((candidate) => candidate.id === media.selectedDisplaySourceId);
    if (!source) return;
    const started = await media.startScreenShare(source);
    if (started) closeHelp();
  };

  const connectedPeerCount = Object.values(peerStates).filter((state) => state === 'connected').length;
  const remotePeerCount = Math.max(0, cloudMembers.length - (localCloudUserId ? 1 : 0));
  const visibleMembers = activeCloudGroup ? cloudMembers : cachedCloudGroup ? cachedCloudMembers : [];
  const membersLoading = activeCloudGroup ? memberLoading : cachedCloudGroup && cachedHistoryLoading;
  const localParticipantId = activeCloudGroup
    ? localCloudUserId
    : cachedCloudMembers.find((member) => member.publicKey === identity?.publicKey)?.userId;

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Navegação de grupos">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">L</div>
          <div className="brand-wordmark">larp<span>.</span></div>
          <span className="build-chip">BETA</span>

        </div>

        <div className={`connection-card connection-${cloudStatus.state}`} aria-label={`Estado da sinalização: ${cloudStatus.state}`}>
          <span className="connection-indicator" />
          <div>
            <strong>{displayCloudGroup ? activeCloudGroup ? meshReady ? 'Chat P2P preparado' : 'Preparando chat P2P' : 'Histórico offline' : cloudStatus.state === 'ready' ? 'Sinalização disponível' : cloudStatus.state === 'connecting' ? 'Conectando ao serviço' : cloudStatus.state === 'unavailable' ? 'Serviço de grupos indisponível' : 'Supabase não configurado'}</strong>
            <span>{displayCloudGroup ? activeCloudGroup ? `${connectedPeerCount}/${remotePeerCount} conexões WebRTC` : 'Somente leitura neste PC' : cloudStatus.state === 'ready' ? 'Selecione ou crie um grupo' : cloudStatus.state === 'connecting' ? 'Aguardando resposta…' : 'Verifique a configuração'}</span>

          </div>
          <Icon name={cloudStatus.state === 'ready' ? 'users' : 'lock'} size={15} />
        </div>

        <div className="sidebar-heading">
          <span>{cloudStatus.state === 'ready' ? 'MEUS GRUPOS' : offlineMode ? 'GRUPOS NESTE PC' : 'GRUPOS'}</span>
          <button className="icon-button small" type="button" aria-label="Criar ou entrar em um grupo" onClick={openGroupManager}>
            <Icon name="plus" size={16} />
          </button>
        </div>

        <nav className="group-list" aria-label="Grupos privados">
          {cloudStatus.state === 'connecting' ? (
            <p className="group-empty">Conectando ao serviço…</p>
          ) : !cachedGroupsLoaded && offlineMode ? (
            <p className="group-empty">Lendo grupos salvos…</p>
          ) : listedCloudGroups.length ? listedCloudGroups.map((group, index) => (
            <button
              className={`group-item ${group.id === selectedCloudGroupId ? 'selected' : ''}`}
              type="button"
              key={group.id}
              onClick={() => selectCloudGroup(group.id)}
              aria-current={group.id === selectedCloudGroupId ? 'page' : undefined}
            >
              <span className={`group-icon group-color-${index % 3}`}><Icon name={index === 1 ? 'grid' : 'bubble'} size={17} /></span>
              <span className="group-copy">
                <strong>{group.name}</strong>
                <span>{group.memberCount}/6 membros{cachedCloudGroup ? ' · offline' : ''}</span>
              </span>
              {group.id === selectedCloudGroupId && <span className="active-mark" aria-hidden="true" />}
            </button>
          )) : (
            <p className="group-empty">{cloudStatus.state === 'ready' ? 'Nenhum grupo ainda. Crie um ou aceite um convite.' : 'Nenhum grupo salvo neste computador.'}</p>
          )}
        </nav>



        <button className="invite-button" type="button" onClick={openGroupManager}>
          <span className="invite-icon"><Icon name="plus" size={17} /></span>
          <span>{displayCloudGroup ? cloudStatus.state === 'ready' ? 'Convidar pessoas' : 'Histórico offline' : 'Criar ou entrar em grupo'}</span>
          {activeCloudGroup && activeCloudGroup.role !== 'owner' && <span className="invite-lock"><Icon name="lock" size={13} /></span>}
        </button>

        <div className="sidebar-footer">
          <div className="profile-avatar" aria-hidden="true">{identity ? 'PC' : 'L'}</div>
          <div className="profile-copy"><strong>{identity ? 'Este computador' : 'Larp'}</strong><span>{identity ? 'Identidade Ed25519 protegida' : 'Identidade indisponível'}</span></div>

          <button className="icon-button profile-info" type="button" aria-label="Ver estado da conexão" onClick={openHelp}>
            <Icon name="info" size={17} />
          </button>
        </div>
      </aside>

      <section className="chat-panel" aria-label="Conversa">
        <header className="chat-header">
          <div className="chat-heading">
            <h1>{activeGroup?.name ?? (cloudStatus.state === 'connecting' ? 'Conectando…' : cloudStatus.state === 'ready' ? 'Nenhum grupo selecionado' : 'Grupos indisponíveis')}</h1>
            <p>{activeCloudGroup ? `${activeCloudGroup.memberCount} membros autorizados` : cachedCloudGroup ? `${cachedCloudGroup.memberCount} membros · somente leitura neste PC` : cloudStatus.state === 'ready' ? 'Crie um grupo ou aceite um convite' : cloudStatus.detail}</p>
          </div>
          <div className="header-actions">
            <span className="header-local-badge"><span />{activeCloudGroup ? `Supabase · ${connectedPeerCount} P2P` : cachedCloudGroup ? 'Offline · somente leitura' : cloudStatus.state === 'connecting' ? 'Conectando' : 'Sem grupo ativo'}</span>
            <button className="icon-button help-trigger" type="button" aria-label="Ver configuração e estado da conexão" onClick={openHelp}>
              <Icon name="info" size={18} />
            </button>
          </div>
        </header>


        <div className={`offline-banner banner-${cloudStatus.state}`} role="status">
          <span className="banner-icon"><Icon name={cachedCloudGroup ? 'lock' : cloudStatus.state === 'ready' ? 'users' : 'info'} size={16} /></span>
          <p>
            <strong>{cachedCloudGroup ? 'Histórico offline disponível.' : activeCloudGroup ? 'Grupo privado conectado.' : cloudStatus.state === 'ready' ? 'Sinalização Supabase disponível.' : cloudStatus.state === 'connecting' ? 'Verificando a conexão.' : cloudStatus.state === 'unavailable' ? 'Serviço de grupos indisponível.' : 'Supabase não configurado.'}</strong>
            {' '}{displayCloudGroup
              ? activeCloudGroup
                ? connectedPeerCount > 0
                  ? `${connectedPeerCount} conexão(ões) WebRTC ativas. Mensagens são assinadas e salvas neste PC antes de sincronizar.`
                  : meshReady
                    ? 'Sem conexões WebRTC agora. Mensagens novas ficam salvas neste PC e serão sincronizadas quando um membro estiver acessível.'
                    : 'Preparando sinalização e identidade do grupo; nenhuma mensagem será enviada sem conexão P2P.'
                : 'O serviço de grupos está offline. Mensagens e membros em cache são somente leitura neste computador.'
              : cloudStatus.state === 'ready'
                ? 'Crie um grupo privado ou entre com um convite de uso único.'
                : cloudStatus.state === 'connecting'
                  ? 'Aguarde a resposta do serviço antes de abrir grupos.'
                  : cachedGroupsLoaded
                    ? `${cloudStatus.detail} Não há grupos salvos neste computador.`
                    : 'Verificando os grupos salvos neste computador.'}
          </p>
          <button type="button" onClick={cloudStatus.state === 'ready' ? openGroupManager : openHelp}>
            {cloudStatus.state === 'ready' ? 'Grupos' : cloudStatus.state === 'connecting' ? 'Estado' : 'Conexão'} <Icon name="arrow" size={14} />
          </button>
        </div>


        <section className="message-list" aria-label={`Mensagens de ${activeGroup?.name ?? 'grupo'}`} aria-live="polite">
          {(media.displayStream || media.remoteVideoStream) && (
            <div className="screen-stage">
              <video ref={media.screenVideoRef} muted={Boolean(media.displayStream)} autoPlay playsInline aria-label={media.displayStream ? 'Prévia da tela compartilhada' : 'Tela compartilhada pelo grupo'} />
              <div className="screen-stage-heading">
                <strong>{media.displayStream ? `Você está compartilhando · ${media.shareSourceName}` : 'Tela compartilhada ao vivo'}</strong>
                {media.shareActive && <span>{media.shareStats.length ? media.shareStats.map(describePeerMediaStats).join('  |  ') : 'Aguardando métricas de envio…'}</span>}
              </div>
            </div>
          )}
          {cloudStatus.state === 'connecting' ? (
            <div className="loading-state"><span className="loading-dot" />Carregando grupos do serviço…</div>
          ) : displayCloudGroup ? activeCloudGroup ? (
            historyLoading ? (
              <div className="loading-state"><span className="loading-dot" />Abrindo histórico assinado neste computador…</div>
            ) : cloudMessagesGroupId === activeCloudGroup.id && cloudMessages.length ? (
              <>
                <div className="date-divider"><span>Histórico P2P assinado</span></div>
                {cloudMessages.map((message) => (
                  <Message key={message.id} message={message} localParticipantId={localCloudUserId} />
                ))}
                <div className="local-note"><span /> Mensagens assinadas; o histórico fica armazenado neste computador.</div>
              </>
            ) : peerError ? (
              <div className="empty-state"><Icon name="info" size={22} /><p>{peerError}</p></div>
            ) : (
              <div className="empty-state"><Icon name="bubble" size={22} /><p>{memberLoading ? 'Carregando membros autorizados…' : meshReady ? 'Ainda não há mensagens assinadas neste histórico.' : 'Preparando a conexão segura do grupo…'}</p></div>
            )
          ) : cachedHistoryLoading ? (
            <div className="loading-state"><span className="loading-dot" />Verificando histórico P2P assinado neste computador…</div>
          ) : cachedHistoryError ? (
            <div className="empty-state"><Icon name="info" size={22} /><p>{cachedHistoryError}</p></div>
          ) : cachedMessages.length ? (
            <>
              <div className="date-divider"><span>Histórico salvo neste PC · somente leitura</span></div>
              {cachedMessages.map((message) => <Message key={message.id} message={message} localParticipantId={localParticipantId} />)}
              <div className="local-note"><span /> Mensagens assinadas e metadados ficam armazenados neste computador.</div>
            </>
          ) : (
            <div className="empty-state"><Icon name="bubble" size={22} /><p>Não há mensagens assinadas deste grupo salvas neste computador.</p></div>
          ) : cloudStatus.state === 'ready' ? (
            <div className="empty-state"><Icon name="users" size={22} /><p>Crie um grupo privado ou aceite um convite para começar.</p><button className="inline-action" type="button" onClick={openGroupManager}>Gerenciar grupos</button></div>
          ) : !cachedGroupsLoaded ? (
            <div className="loading-state"><span className="loading-dot" />Lendo grupos salvos neste computador…</div>
          ) : (
            <div className="empty-state"><Icon name="info" size={22} /><p>{cloudStatus.detail} Nenhum grupo real está disponível neste computador. Verifique a conexão ou configuração do Supabase.</p><button className="inline-action" type="button" onClick={openHelp}>Ver conexão</button></div>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
        </section>


        <div className="chat-bottom">
          <div className="call-dock" aria-label="Controles de voz">
            <div className="call-status"><span className={`call-status-dot ${media.callActive ? 'call-status-live' : ''}`} /><span>{media.callActive ? `Voz ativa · ${connectedPeerCount} membro(s)` : activeCloudGroup ? `${connectedPeerCount}/${remotePeerCount} conexões P2P · voz desligada` : 'Conecte-se a um grupo para iniciar a chamada'}</span></div>

            <div className="call-actions">
              <button
                type="button"
                className={`call-control ${media.micMuted ? 'call-control-muted' : ''}`}
                disabled={!activeCloudGroup || !media.mediaReady || media.audioBusy}
                aria-label={media.callActive ? media.micMuted ? 'Ativar microfone' : 'Silenciar microfone' : 'Configurar microfone'}
                aria-pressed={media.callActive ? media.micMuted : undefined}
                onClick={media.callActive ? media.toggleMicrophoneMuted : openAudioSettings}
              >
                <Icon name="mic" size={17} /><span>{media.callActive ? media.micMuted ? 'Mic silenciado' : 'Microfone' : 'Microfone'}</span>
              </button>
              <button
                type="button"
                className={`call-control ${media.playbackMuted ? 'call-control-muted' : ''}`}
                disabled={!activeCloudGroup || !media.mediaReady}
                aria-label={media.playbackMuted ? 'Ativar áudio recebido' : 'Silenciar áudio recebido'}
                aria-pressed={media.playbackMuted}
                onClick={media.togglePlaybackMuted}
              >
                <Icon name="headphones" size={17} /><span>{media.playbackMuted ? 'Áudio silenciado' : 'Saída de áudio'}</span>
              </button>
              <button type="button" className="call-control device-control" disabled={!activeCloudGroup || !media.mediaReady} onClick={openAudioSettings}>Dispositivos</button>
              <button
                type="button"
                className={`call-join ${media.callActive ? 'call-join-leave' : ''}`}
                disabled={!activeCloudGroup || !meshReady || !media.mediaReady || connectedPeerCount === 0 || media.audioBusy}
                title={connectedPeerCount === 0 ? 'A chamada exige ao menos um participante conectado' : 'A voz é enviada aos participantes conectados'}
                onClick={(event) => {
                  if (media.callActive) void media.stopCall();
                  else if (!media.selectedMicrophoneId) openAudioSettings(event);
                  else void media.startCall();
                }}
              >
                {media.callActive ? 'Sair da chamada' : 'Entrar na chamada'} <Icon name="arrow" size={15} />
              </button>
            </div>
          </div>

          <form className="composer" onSubmit={saveMessage}>
            <label className="sr-only" htmlFor="message-input">Mensagem assinada do grupo</label>
            <textarea
              id="message-input"
              placeholder={activeCloudGroup ? meshReady ? 'Escreva uma mensagem assinada…' : 'Preparando conexão P2P…' : cachedCloudGroup ? 'Histórico offline · somente leitura' : cloudStatus.state === 'ready' ? 'Selecione um grupo privado para conversar…' : 'Conecte-se a um grupo para enviar mensagens…'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={4000}
              rows={2}
              disabled={!activeCloudGroup || !meshReady || !localCloudUserId || sending}
            />
            <div className="composer-footer">
              <span className="composer-hint">{activeCloudGroup ? meshReady ? 'Assinada · sincronização P2P' : 'Preparando o grupo' : cachedCloudGroup ? 'Somente leitura' : cloudStatus.state === 'ready' ? 'Selecione um grupo' : 'Envio indisponível'} <span aria-hidden="true">·</span> {draft.length}/4.000</span>
              <button className="send-button" type="submit" disabled={!activeCloudGroup || !meshReady || !localCloudUserId || !draft.trim() || sending}>
                <span>{sending ? 'Enviando…' : activeCloudGroup ? 'Enviar P2P' : cachedCloudGroup ? 'Somente leitura' : 'Sem grupo'}</span>
                <Icon name="send" size={15} />
              </button>
            </div>
          </form>
          <div className="feedback-area" aria-live="polite">
            {notice && <span className="success-note">{notice}</span>}
            {error && <span className="inline-error" role="alert">{error}</span>}
            {cloudError && <span className="inline-error">{cloudError}</span>}
            {media.audioError && <span className="inline-error" role="alert">{media.audioError}</span>}
            {media.shareError && <span className="inline-error" role="alert">{media.shareError}</span>}
          </div>

        </div>

      </section>

      <aside className="details-panel" aria-label="Detalhes do grupo">
        <div className="details-header">
          <h2>Grupo</h2>
          <button className="icon-button" type="button" aria-label="Sobre a conexão" onClick={openHelp}><Icon name="info" size={17} /></button>
        </div>

        <section className="group-summary">
          <div className="summary-icon"><Icon name="bubble" size={22} /></div>
          <h3>{activeGroup?.name ?? 'Nenhum grupo selecionado'}</h3>
          <p>{activeCloudGroup ? 'Grupo privado · conectado' : cachedCloudGroup ? 'Grupo privado · offline e somente leitura' : 'Grupos e mensagens só aparecem após conexão.'}</p>
          <span className="summary-tag"><Icon name="lock" size={12} />{activeCloudGroup ? 'GRUPO PRIVADO' : cachedCloudGroup ? 'OFFLINE · LEITURA' : 'SEM GRUPO'}</span>
        </section>


        <div className="details-divider" />

        <section className="members-section">
          <div className="section-title"><h3>Membros</h3><span>{displayCloudGroup?.memberCount ?? '—'}</span></div>
          <p className="section-caption">{activeCloudGroup ? 'Membros autorizados; presença não verificada' : cachedCloudGroup ? 'Metadados salvos; presença indisponível offline' : 'Selecione um grupo disponível.'}</p>
          <ul className="member-list">
            {membersLoading && <li className="member-loading">Carregando membros…</li>}
            {visibleMembers.map((member) => {
              const isSelf = member.publicKey === identity?.publicKey
                || (cloudStatus.state === 'ready' && member.userId === cloudStatus.userId);
              const label = isSelf ? 'Este computador' : `PC · ${member.userId.slice(-6).toUpperCase()}`;
              const roleLabel = member.role === 'owner' ? 'Responsável' : 'Membro';
              const memberContext = cachedCloudGroup
                ? `${roleLabel} · offline`
                : `${roleLabel} · ${isSelf ? 'neste PC' : 'presença não verificada'}`;
              return (
                <li key={member.userId} className="member-row">
                  <span className={`avatar member-avatar ${isSelf ? 'avatar-local' : ''}`} aria-hidden="true">{isSelf ? 'PC' : member.userId.slice(-2).toUpperCase()}</span>
                  <span className="member-name"><strong>{label}</strong><span>{memberContext}</span></span>
                  {activeCloudGroup?.role === 'owner' && !isSelf && (
                    <button className="remove-member" type="button" disabled={Boolean(cloudAction)} aria-label={`Remover ${label}`} title="Remover membro" onClick={() => void removeMember(member)}>
                      <Icon name="close" size={14} />
                    </button>
                  )}
                  {!cachedCloudGroup && <span className={`member-state ${isSelf ? 'state-local' : ''}`} aria-label={isSelf ? 'Este computador' : 'Presença não verificada'} />}
                </li>
              );
            })}
          </ul>
        </section>


        <section className={`share-card ${media.shareActive ? 'share-card-active' : ''}`}>
          <div className="share-card-icon"><Icon name="screen" size={18} /></div>
          <div><strong>{media.shareActive ? 'Compartilhando tela' : 'Compartilhar tela'}</strong><span>{media.shareActive ? `${media.shareSourceName} · ${media.screenMode === 'motion' ? 'Movimento' : 'Texto'}` : activeCloudGroup ? meshReady ? 'Escolha uma tela ou janela' : 'Aguardando conexão P2P' : 'Disponível em grupos privados'}</span></div>
          <button type="button" disabled={!media.shareActive && (!activeCloudGroup || !meshReady || !media.mediaReady)} aria-label={media.shareActive ? 'Parar compartilhamento de tela' : 'Selecionar tela para compartilhar'} title={media.shareActive ? 'Parar transmissão e liberar a captura' : 'Selecionar explicitamente uma tela ou janela'} onClick={(event) => media.shareActive ? void media.stopScreenShare() : openScreenSettings(event)}>
            <Icon name={media.shareActive ? 'close' : 'chevron'} size={16} />
          </button>
        </section>

        <div className="privacy-note"><Icon name="lock" size={14} /><p>{activeCloudGroup ? 'O Supabase armazena metadados do grupo. Mensagens assinadas permanecem nos PCs.' : cachedCloudGroup ? 'Grupo, membros e mensagens assinadas salvos neste PC; somente leitura offline.' : 'Conecte-se a um grupo para acessar mensagens e membros.'}</p></div>

      </aside>

      {helpOpen && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHelp(); }}>
          <section className={`connection-dialog ${dialogMode === 'groups' ? 'group-manager-dialog' : dialogMode === 'audio' ? 'audio-settings-dialog' : dialogMode === 'screen' ? 'screen-settings-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title" aria-describedby="connection-dialog-description">
            <button ref={helpCloseRef} className="icon-button dialog-close" type="button" aria-label="Fechar diálogo" onClick={closeHelp}><Icon name="close" size={18} /></button>
            {dialogMode === 'connection' ? (
              <>
                <div className="dialog-mark"><Icon name="lock" size={21} /></div>
                <h2 id="connection-dialog-title">Estado da conexão</h2>
                <p id="connection-dialog-description">{cloudStatus.detail}</p>
                <div className="dialog-checklist">
                  <div><span className={identity ? 'check-ready' : 'check-empty'} /><span>Identidade Ed25519 protegida pelo Windows</span><strong>{identity ? 'Disponível' : 'Indisponível'}</strong></div>
                  <div><span className={cloudStatus.state === 'ready' ? 'check-ready' : 'check-empty'} /><span>Supabase Auth e grupos privados</span><strong>{cloudStatus.state === 'ready' ? 'Disponível' : cloudStatus.state === 'not-configured' ? 'Não configurado' : cloudStatus.state === 'connecting' ? 'Verificando' : 'Indisponível'}</strong></div>
                  <div><span className={connectedPeerCount ? 'check-ready' : 'check-empty'} /><span>Chat e mídia P2P</span><strong>{!activeCloudGroup ? cloudStatus.state === 'ready' ? 'Sem grupo ativo' : 'Não configurado' : connectedPeerCount ? `${connectedPeerCount} conectado(s)` : meshReady ? 'Aguardando participantes' : 'Preparando'}</strong></div>
                  <div><span className={activeCloudGroup && turnStatus === 'available' ? 'check-ready' : 'check-empty'} /><span>TURN gratuito · fallback direto</span><strong>{!activeCloudGroup ? cloudStatus.state === 'ready' ? 'Sem grupo ativo' : 'Não configurado' : turnStatus === 'checking' ? 'Consultando' : turnStatus === 'available' ? 'Credenciais disponíveis' : 'Sem credenciais'}</strong></div>
                </div>
                {cloudStatus.state === 'not-configured' && (
                  <p className="config-hint">Configure <code>supabaseUrl</code> e <code>supabaseAnonKey</code> no arquivo <code>config.json</code> da pasta de dados do Larp. Nunca use uma chave service-role.</p>
                )}
                {cloudError && <p className="dialog-error" role="alert">{cloudError}</p>}
                <div className="dialog-actions">
                  <button className="dialog-secondary" type="button" disabled={cloudAction === 'refresh'} onClick={() => void refreshCloudStatus()}>
                    {cloudAction === 'refresh' ? 'Verificando…' : 'Atualizar conexão'}
                  </button>
                  <button className="dialog-secondary" type="button" disabled={!activeCloudGroup || !meshReady || turnStatus === 'checking'} onClick={retryTurn}>Tentar TURN novamente</button>
                  <button className="dialog-done" type="button" onClick={closeHelp}>Fechar</button>
                </div>
              </>
            ) : dialogMode === 'groups' ? (
              <>
                <h2 id="connection-dialog-title">Grupos privados</h2>
                <p id="connection-dialog-description">{cloudStatus.state === 'ready' ? 'Crie um grupo ou entre com um código de convite de uso único.' : cloudStatus.detail}</p>
                <div className="group-manager-forms">
                  <form onSubmit={createCloudGroup}>
                    <label htmlFor="new-group-name">Criar grupo</label>
                    <input id="new-group-name" type="text" maxLength={80} value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Nome do grupo" disabled={cloudStatus.state !== 'ready' || Boolean(cloudAction)} />
                    <button className="dialog-done" type="submit" disabled={cloudStatus.state !== 'ready' || !newGroupName.trim() || Boolean(cloudAction)}>
                      {cloudAction === 'create' ? 'Criando…' : 'Criar grupo'}
                    </button>
                  </form>
                  <form onSubmit={acceptCloudInvite}>
                    <label htmlFor="join-group-code">Entrar com convite</label>
                    <input id="join-group-code" type="text" maxLength={43} value={joinInviteCode} onChange={(event) => setJoinInviteCode(event.target.value)} placeholder="Cole o código de convite" disabled={cloudStatus.state !== 'ready' || Boolean(cloudAction)} />
                    <button className="dialog-secondary" type="submit" disabled={cloudStatus.state !== 'ready' || !joinInviteCode.trim() || Boolean(cloudAction)}>
                      {cloudAction === 'join' ? 'Entrando…' : 'Aceitar convite'}
                    </button>
                  </form>
                </div>
                {activeCloudGroup?.role === 'owner' && (
                  <section className="invite-manager">
                    <h3>Convites de “{activeCloudGroup.name}”</h3>
                    {createdInvite && (
                      <div className="created-invite">
                        <label htmlFor="invite-code">Código válido até {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(createdInvite.expiresAt))}</label>
                        <input id="invite-code" className="invite-code-input" type="text" readOnly value={createdInvite.code} onFocus={(event) => event.currentTarget.select()} />
                        <button className="dialog-secondary" type="button" onClick={() => void copyInvite()}>Copiar código</button>
                      </div>
                    )}
                    <ul className="invite-summary-list">
                      {inviteSummaries.map((invite) => (
                        <li key={invite.id}>
                          <span>Expira em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(invite.expiresAt))}</span>
                          <button className="dialog-danger" type="button" disabled={Boolean(cloudAction)} onClick={() => void revokeInvite(invite.id)}>
                            {cloudAction === 'revoke' ? 'Revogando…' : 'Revogar'}
                          </button>
                        </li>
                      ))}
                      {inviteSummaries.length === 0 && <li className="invite-empty">Nenhum convite ativo.</li>}
                    </ul>
                    <button className="dialog-secondary" type="button" disabled={Boolean(cloudAction) || activeCloudGroup.memberCount >= 6} onClick={() => void makeInvite()}>
                      {activeCloudGroup.memberCount >= 6 ? 'Grupo cheio (6/6)' : cloudAction === 'invite' ? 'Criando…' : 'Gerar convite'}
                    </button>
                  </section>
                )}
                {activeCloudGroup && (
                  <div className="group-leave-row">
                    <span>{activeCloudGroup.role === 'owner' ? 'Você é responsável por este grupo.' : 'Remova seu acesso a este grupo.'}</span>
                    <button className="dialog-danger" type="button" disabled={Boolean(cloudAction) || cloudStatus.state !== 'ready'} onClick={() => void leaveCloudGroup()}>
                      {cloudAction === 'leave' ? 'Saindo…' : 'Sair do grupo'}
                    </button>
                  </div>
                )}
                {cloudError && <p className="dialog-error" role="alert">{cloudError}</p>}
                {cloudNotice && <p className="dialog-success" role="status">{cloudNotice}</p>}
                <div className="dialog-actions">
                  {cloudStatus.state !== 'ready' && <button className="dialog-secondary" type="button" disabled={cloudAction === 'refresh'} onClick={() => void refreshCloudStatus()}>{cloudAction === 'refresh' ? 'Verificando…' : 'Atualizar conexão'}</button>}
                  <button className="dialog-done" type="button" onClick={closeHelp}>Fechar</button>
                </div>
              </>
            ) : dialogMode === 'audio' ? (
              <>
                <h2 id="connection-dialog-title">Dispositivos de áudio</h2>
                <p id="connection-dialog-description">Escolha o microfone e a saída deste computador. O microfone só transmite depois que você entrar na chamada.</p>
                <div className="media-form">
                  <label htmlFor="microphone-device">Microfone</label>
                  <select id="microphone-device" value={media.selectedMicrophoneId} disabled={media.audioBusy || media.callActive} onChange={(event) => media.selectMicrophone(event.target.value)}>
                    <option value="">Selecione um microfone</option>
                    {media.audioInputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                  </select>
                  <div className="device-actions">
                    <button className="dialog-secondary" type="button" disabled={media.audioBusy} onClick={() => void media.refreshAudioDevices(true)}>{media.audioBusy ? 'Verificando…' : 'Permitir e listar dispositivos'}</button>
                    <button className="dialog-secondary" type="button" disabled={media.audioBusy || !media.selectedMicrophoneId} onClick={() => void media.testMicrophone()}>{media.microphoneTestActive ? 'Parar teste' : 'Testar microfone'}</button>
                  </div>
                  <div className="microphone-meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={media.microphoneLevel}>
                    <span style={{ width: `${media.microphoneLevel}%` }} />
                  </div>
                  <label htmlFor="output-device">Saída de áudio</label>
                  <select id="output-device" value={media.selectedOutputId} disabled={media.audioBusy} onChange={(event) => void media.selectAudioOutput(event.target.value)}>
                    <option value="">Saída padrão</option>
                    {media.audioOutputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                  </select>
                  <button className="dialog-secondary output-test" type="button" disabled={media.audioBusy} onClick={() => void media.testOutput()}>Reproduzir tom de teste</button>
                </div>
                {media.callActive && <p className="dialog-success" role="status">A voz está ativa; alterações de microfone exigem sair da chamada.</p>}
                {media.audioError && <p className="dialog-error" role="alert">{media.audioError}</p>}
                <div className="dialog-actions"><button className="dialog-done" type="button" onClick={closeHelp}>Concluir</button></div>
              </>
            ) : (
              <>
                <h2 id="connection-dialog-title">Compartilhar tela</h2>
                <p id="connection-dialog-description">Selecione explicitamente uma tela ou janela. O áudio do sistema começa desativado e a transmissão pode usar TURN se houver credenciais gratuitas.</p>
                <div className="media-form">
                  <div className="source-heading">
                    <strong>Fonte de captura</strong>
                    <button className="dialog-secondary" type="button" onClick={() => void media.refreshDisplaySources()}>Atualizar lista</button>
                  </div>
                  <div className="screen-source-list" role="radiogroup" aria-label="Telas e janelas disponíveis">
                    {media.displaySources.map((source) => (
                      <label key={source.id} className={`screen-source-option ${media.selectedDisplaySourceId === source.id ? 'source-selected' : ''}`}>
                        <input type="radio" name="screen-source" value={source.id} checked={media.selectedDisplaySourceId === source.id} onChange={() => media.setSelectedDisplaySourceId(source.id)} />
                        <span><strong>{source.kind === 'screen' ? 'Monitor' : 'Janela'}</strong><span>{source.name}</span></span>
                      </label>
                    ))}
                    {media.displaySources.length === 0 && <p className="source-empty">Nenhuma tela ou janela disponível. Atualize a lista e verifique as permissões do Windows.</p>}
                  </div>
                  <fieldset className="mode-options">
                    <legend>Prioridade de qualidade</legend>
                    <label><input type="radio" name="screen-mode" checked={media.screenMode === 'motion'} onChange={() => media.setScreenMode('motion')} /><span><strong>Movimento</strong><small>Até 60 FPS; adapta a resolução conforme rede e codificador.</small></span></label>
                    <label><input type="radio" name="screen-mode" checked={media.screenMode === 'text'} onChange={() => media.setScreenMode('text')} /><span><strong>Texto</strong><small>Prioriza resolução e legibilidade; até 30 FPS.</small></span></label>
                  </fieldset>
                  <label className="system-audio-option"><input type="checkbox" checked={media.includeSystemAudio} onChange={(event) => media.setIncludeSystemAudio(event.target.checked)} /><span>Incluir áudio do sistema <small>Desativado por padrão; requer suporte do Windows e do Electron.</small></span></label>
                  <label className="budget-label" htmlFor="video-budget">Orçamento total de vídeo: <strong>{media.videoBudgetMbps} Mb/s</strong></label>
                  <input id="video-budget" className="budget-slider" type="range" min={1} max={20} step={1} value={media.videoBudgetMbps} onChange={(event) => media.setVideoBudgetMbps(Number(event.target.value))} />
                </div>
                {media.shareError && <p className="dialog-error" role="alert">{media.shareError}</p>}
                <div className="dialog-actions">
                  <button className="dialog-secondary" type="button" onClick={closeHelp}>Cancelar</button>
                  <button className="dialog-done" type="button" disabled={!media.selectedDisplaySourceId || media.shareStarting || !media.mediaReady} onClick={() => void startSelectedScreenShare()}>
                    {media.shareStarting ? 'Preparando captura…' : 'Iniciar compartilhamento'}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <audio ref={media.audioElementRef} className="sr-only" autoPlay aria-label="Áudio remoto" />
    </main>
  );
}

export default App;
