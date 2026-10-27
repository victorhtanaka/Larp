import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import type { ChatMessage, SelectedDisplaySource, TurnCredentialServer } from '../shared/contracts';
import type { CloudConnectionStatus, GroupInvite, GroupInviteSummary, GroupMember, GroupPresenceStatus, GroupSummary, PublicIdentity, UserProfile } from '../shared/cloud-contracts';
import { USER_PROFILE_AVATAR_MAX_BYTES, USER_PROFILE_NAME_MAX_LENGTH, USER_PROFILE_SOURCE_MAX_BYTES } from '../shared/cloud-contracts';
import type { SignedChatEnvelope } from '../shared/webrtc-protocol';
import { createGroupPeerMesh } from './rtc/create-peer-mesh';
import type { PeerMesh, PeerConnectionStatus } from './rtc/peer-mesh';
import { useMediaController } from './media/use-media-controller';
import { connectionPresentation } from './presentation';
import { notificationsReducer, type AppNotification } from './notifications';
import { resolveLocalPresenceStatus, resolveMemberPresence, type MemberPresenceStatus } from './presence';
import larpWordmarkUrl from '../assets/larp-wordmark.png';

const INITIAL_CLOUD_STATUS: CloudConnectionStatus = {
  state: 'connecting',
  detail: 'Verificando a configuração de grupos…',
  groups: [],
};

function describeError(_error: unknown, fallback: string): string {
  return fallback;
}

type IconName = 'bubble' | 'bell' | 'grid' | 'plus' | 'arrow' | 'info' | 'lock' | 'send' | 'mic' | 'headphones' | 'screen' | 'expand' | 'shrink' | 'users' | 'close' | 'chevron' | 'spark';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    bubble: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 2 1-4.5A7.5 7.5 0 1 1 20 11.5Z" /><path d="M7 11h.01M12 11h.01M17 11h.01" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
    send: <><path d="m21 3-7.2 18-3.8-7-7-3.8L21 3Z" /><path d="M10 14 21 3" /></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" /></>,
    headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3" /><rect x="3" y="13" width="4" height="7" rx="2" /><rect x="17" y="13" width="4" height="7" rx="2" /></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    expand: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /></>,
    shrink: <><path d="M8 3v3a2 2 0 0 1-2 2H3M21 3h-3a2 2 0 0 0-2 2v3M3 21h3a2 2 0 0 0 2-2v-3M21 21h-3a2 2 0 0 1-2-2v-3" /></>,
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

const DEFAULT_ACCENT_COLOR = '#78a9ff';
const ACCENT_COLOR_STORAGE_KEY = 'larp-accent-color';


function loadAccentColor(): string {
  try {
    const saved = window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
    return saved && /^#[\da-f]{6}$/i.test(saved) ? saved.toLowerCase() : DEFAULT_ACCENT_COLOR;
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}

function getAccentForeground(color: string): string {
  const linearize = (index: number) => {
    const channel = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linearize(1) + 0.7152 * linearize(3) + 0.0722 * linearize(5);
  const darkContrast = (luminance + 0.05) / 0.053;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? '#0a0a0a' : '#ffffff';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function profileInitials(name: string | null | undefined, fallback: string): string {
  const characters = Array.from(name?.trim() ?? '');
  return characters.length ? characters.slice(0, 2).join('').toLocaleUpperCase('pt-BR') : fallback;
}

type AvatarPresence = MemberPresenceStatus;
function ProfileAvatar({ profile, initials, className, presence }: {
  profile?: UserProfile | null;
  initials: string;
  className: string;
  presence?: AvatarPresence;
}) {
  const avatar = (
    <div className={className} aria-hidden="true">
      {profile?.avatarData ? <img src={profile.avatarData} alt="" draggable={false} /> : initials}
    </div>
  );
  if (!presence) return avatar;
  const presenceLabel = presence === 'online' ? 'Online' : presence === 'away' ? 'Ausente' : 'Offline';
  return (
    <span className={`presence-avatar presence-avatar-${presence}`} role="img" aria-label={presenceLabel} title={presenceLabel}>
      {avatar}
      <span className={`presence-indicator presence-indicator-${presence}`} aria-hidden="true" />
    </span>
  );
}

function NotificationCenter({ notifications, onOpen, onClear }: {
  notifications: readonly AppNotification[];
  onOpen: (notification: AppNotification) => void;
  onClear: () => void;
}) {
  return (
    <div className="notification-center">
      <header className="notification-center-header">
        <div>
          <h2>Notificações</h2>
          <p>Mensagens recebidas e entradas em chamadas.</p>
        </div>
        {notifications.length > 0 && (
          <button className="notification-clear" type="button" onClick={onClear}>Limpar tudo</button>
        )}
      </header>
      {notifications.length === 0 ? (
        <div className="notification-empty">
          <Icon name="bell" size={22} />
          <p>As novidades dos seus grupos aparecerão aqui.</p>
        </div>
      ) : (
        <ol className="notification-list">
          {notifications.map((notification) => (
            <li key={notification.id}>
              <button
                className={`notification-item${notification.read ? '' : ' notification-item-unread'}`}
                type="button"
                onClick={() => onOpen(notification)}
              >
                <span className={`notification-kind-icon notification-kind-${notification.kind}`}>
                  <Icon name={notification.kind === 'message' ? 'bubble' : 'mic'} size={17} />
                </span>
                <span className="notification-item-copy">
                  <strong>{notification.kind === 'message' ? 'Nova mensagem' : 'Entrou na chamada'}</strong>
                  <span>{notification.actorName} · {notification.groupName}</span>
                  <time dateTime={notification.createdAt}>{formatTime(notification.createdAt)}</time>
                </span>
                {!notification.read && <span className="notification-unread-dot" aria-label="Não lida" />}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

async function avatarDataFromFile(file: File): Promise<string> {
  if (file.size < 1 || file.size > USER_PROFILE_SOURCE_MAX_BYTES) {
    throw new Error('A foto selecionada não pode ser usada. Escolha outra imagem.');
  }
  const image = await createImageBitmap(file);
  try {
    if (image.width > 8192 || image.height > 8192 || image.width * image.height > 33_554_432) {
      throw new Error('Escolha uma imagem menor para a foto de perfil.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Não foi possível preparar a foto de perfil.');
    const cropSize = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - cropSize) / 2,
      (image.height - cropSize) / 2,
      cropSize,
      cropSize,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    let thumbnail: Blob | null = null;
    for (const quality of [0.86, 0.72, 0.58, 0.44, 0.3]) {
      thumbnail = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/webp', quality);
      });
      if (!thumbnail || thumbnail.type !== 'image/webp') {
        throw new Error('Não foi possível preparar a foto neste computador.');
      }
      if (thumbnail.size <= USER_PROFILE_AVATAR_MAX_BYTES) break;
    }
    if (!thumbnail || thumbnail.size > USER_PROFILE_AVATAR_MAX_BYTES) {
      throw new Error('A foto ficou grande demais. Escolha outra imagem.');
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Não foi possível ler a foto de perfil.'));
      reader.onerror = () => reject(new Error('Não foi possível ler a foto de perfil.'));
      reader.readAsDataURL(thumbnail);
    });
  } finally {
    image.close();
  }
}

function Message({ message, localParticipantId, profile }: {
  message: ChatMessage;
  localParticipantId?: string;
  profile?: UserProfile | null;
}) {
  const isLocal = message.authorId === localParticipantId;
  return (
    <article className={`message ${isLocal ? 'message-local' : ''}`}>
      <ProfileAvatar
        className={`avatar ${isLocal ? 'avatar-local' : ''}`}
        profile={profile}
        initials={profileInitials(profile?.displayName, message.authorInitials)}
      />
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{profile?.displayName ?? message.authorName}</span>
          <span className={`message-origin ${isLocal ? 'origin-local' : ''}`}>{isLocal ? 'Você' : 'Grupo'}</span>
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
    authorName: isLocal ? 'Este computador' : `Participante · ${message.senderId.slice(-6).toUpperCase()}`,
    authorInitials: isLocal ? 'PC' : message.senderId.slice(-2).toUpperCase(),
    content: message.content,
    sequence: message.sequence,
    createdAt: message.createdAt,
  };
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
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, GroupPresenceStatus>>({});
  const [presenceReady, setPresenceReady] = useState(false);
  const [localPresenceStatus, setLocalPresenceStatus] = useState<AvatarPresence>('offline');
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
  const profilesByUserIdRef = useRef(new Map<string, UserProfile>());
  const [memberLoading, setMemberLoading] = useState(false);
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [myProfile, setMyProfile] = useState<UserProfile | null>();
  const [profileName, setProfileName] = useState('');
  const [profileAvatarData, setProfileAvatarData] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profilePhotoBusy, setProfilePhotoBusy] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
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
  const [dialogMode, setDialogMode] = useState<'connection' | 'groups' | 'audio' | 'screen' | 'profile' | 'appearance'>('connection');
  const [screenViewerExpanded, setScreenViewerExpanded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accentColor, setAccentColor] = useState(loadAccentColor);
  const [notifications, dispatchNotifications] = useReducer(notificationsReducer, []);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsOpenRef = useRef(false);
  const previousRemoteAudioPeerIdsRef = useRef<{ groupId?: string; peerIds: Set<string> }>({ peerIds: new Set() });
  const addNotification = useCallback((notification: Omit<AppNotification, 'createdAt' | 'read'>) => {
    dispatchNotifications({
      type: 'add',
      notification: { ...notification, createdAt: new Date().toISOString(), read: notificationsOpenRef.current },
    });
  }, []);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--accent', accentColor);
    document.documentElement.style.setProperty('--accent-foreground', getAccentForeground(accentColor));
  }, [accentColor]);
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const screenViewerToggleRef = useRef<HTMLButtonElement>(null);
  const offlineMode = cloudStatus.state === 'unavailable' || cloudStatus.state === 'not-configured';
  const connectionCopy = connectionPresentation(cloudStatus);
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
  const meshMembershipKey = JSON.stringify(cloudMembers.map((member) => [
    member.userId,
    member.publicKey,
    member.joinedAt,
    member.role,
  ]));
  // Profile-only updates must not tear down active peer connections.
  const meshMembers = useMemo(() => cloudMembers.map(({ userId, publicKey, joinedAt, role }) => ({
    userId,
    publicKey,
    joinedAt,
    role,
    profile: null,
  })), [meshMembershipKey]);


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
  const openProfileEditor = async (event: MouseEvent<HTMLButtonElement>) => {
    helpTriggerRef.current = event.currentTarget;
    if (cloudStatus.state !== 'ready') return;
    setDialogMode('profile');
    setHelpOpen(true);
    setProfileError('');
    setProfileNotice('');
    setProfileName(myProfile?.displayName ?? '');
    setProfileAvatarData(myProfile?.avatarData ?? null);
    setProfileLoading(true);
    try {
      const profile = await window.larp.getMyProfile();
      setMyProfile(profile);
      setProfileName(profile?.displayName ?? '');
      setProfileAvatarData(profile?.avatarData ?? null);
    } catch (cause) {
      setProfileError(describeError(cause, 'Não foi possível carregar seu perfil.'));
    } finally {
      setProfileLoading(false);
    }
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

  const chooseAccentColor = (value: string) => {
    if (!/^#[\da-f]{6}$/i.test(value)) return;
    const normalized = value.toLowerCase();
    setAccentColor(normalized);
    try {
      window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, normalized);
    } catch {
      // The UI still uses the selected color if local storage is unavailable.
    }
  };
  const restoreDefaultAccentColor = () => {
    setAccentColor(DEFAULT_ACCENT_COLOR);
    try {
      window.localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
    } catch {
      // The UI still uses the default color if local storage is unavailable.
    }
  };
  const openAppearanceSettings = (event: MouseEvent<HTMLButtonElement>) => {
    helpTriggerRef.current = event.currentTarget;
    setDialogMode('appearance');
    setHelpOpen(true);
  };

  const changeScreenViewerMode = useCallback((expanded: boolean) => {
    setScreenViewerExpanded(expanded);
    void window.larp.setScreenViewerExpanded(expanded).catch((cause: unknown) => {
      setScreenViewerExpanded(false);
      setError(describeError(cause, 'Não foi possível alterar a visualização da tela.'));
      void window.larp.setScreenViewerExpanded(false).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    if (!screenViewerExpanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      changeScreenViewerMode(false);
      requestAnimationFrame(() => screenViewerToggleRef.current?.focus());
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [changeScreenViewerMode, screenViewerExpanded]);


  useEffect(() => {
    void window.larp.refreshCloud()
      .then(setCloudStatus)
      .catch((cause: unknown) => setCloudError(describeError(cause, 'Não foi possível atualizar os grupos.')));
    void window.larp.getPublicIdentity().then(setIdentity).catch(() => setIdentity(null));
  }, []);
  useEffect(() => {
    if (!localCloudUserId) return;
    let current = true;
    setMyProfile(undefined);
    void window.larp.getMyProfile()
      .then((profile) => { if (current) setMyProfile(profile); })
      .catch((cause: unknown) => {
        if (current) setCloudError(describeError(cause, 'Não foi possível carregar seu perfil.'));
      });
    return () => { current = false; };
  }, [localCloudUserId]);


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
        setMyProfile(members.find((member) => member.userId === localCloudUserId)?.profile ?? null);
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
            setMyProfile(members.find((member) => member.userId === localCloudUserId)?.profile ?? null);
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
    const groupId = activeCloudGroup?.id;
    if (!groupId || !localCloudUserId || memberGroupId !== groupId || memberLoading) {
      setPresenceByUserId({});
      setPresenceReady(false);
      setLocalPresenceStatus('offline');
      return;
    }

    let active = true;
    let channelReady = false;
    let currentStatus: GroupPresenceStatus = 'online';
    let lastActivity = Date.now();
    setPresenceByUserId({});
    setPresenceReady(false);
    setLocalPresenceStatus('online');

    const publish = (status: GroupPresenceStatus) => {
      if (!active || currentStatus === status) return;
      currentStatus = status;
      setLocalPresenceStatus(status);
      if (channelReady) {
        void window.larp.setCloudPresence(groupId, status).catch(() => {
          if (active) {
            channelReady = false;
            setPresenceReady(false);
          }
        });
      }
    };
    const onActivity = () => {
      lastActivity = Date.now();
      if (document.visibilityState === 'visible' && document.hasFocus()) publish('online');
    };
    const refreshPresence = () => publish(resolveLocalPresenceStatus(
      document.visibilityState === 'visible',
      document.hasFocus(),
      lastActivity,
      Date.now(),
    ));
    const unsubscribe = window.larp.subscribeCloudPresence(
      groupId,
      (presence, ready) => {
        if (!active) return;
        setPresenceByUserId(presence);
        setPresenceReady(ready);
        if (ready && !channelReady && currentStatus !== 'online') {
          void window.larp.setCloudPresence(groupId, currentStatus).catch(() => {
            if (active) {
              channelReady = false;
              setPresenceReady(false);
            }
          });
        }
        channelReady = ready;
      },
      () => {
        if (active) {
          channelReady = false;
          setPresenceReady(false);
        }
      },
    );
    const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of activityEvents) document.addEventListener(event, onActivity, { passive: true });
    window.addEventListener('focus', onActivity);
    window.addEventListener('blur', refreshPresence);
    document.addEventListener('visibilitychange', refreshPresence);
    const timer = window.setInterval(refreshPresence, 15_000);
    refreshPresence();

    return () => {
      active = false;
      window.clearInterval(timer);
      for (const event of activityEvents) document.removeEventListener(event, onActivity);
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', refreshPresence);
      document.removeEventListener('visibilitychange', refreshPresence);
      unsubscribe();
    };
  }, [activeCloudGroup?.id, localCloudUserId, memberGroupId, memberLoading]);

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
  const media = useMediaController({ groupId: activeCloudGroup?.id, mesh: activeMesh, connectedPeerIds, localParticipantId: localCloudUserId });
  useEffect(() => {
    if (media.displayStream || media.remoteVideoStream || !screenViewerExpanded) return;
    changeScreenViewerMode(false);
  }, [changeScreenViewerMode, media.displayStream, media.remoteVideoStream, screenViewerExpanded]);
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
          members: meshMembers,
          turnServers,
          onMessage: (message) => {
            if (!current) return;
            persistedCloudMessageIds.current.add(message.messageId);
            if (message.senderId !== localCloudUserId) {
              const actorName = profilesByUserIdRef.current.get(message.senderId)?.displayName?.trim()
                || `Participante · ${message.senderId.slice(-6).toUpperCase()}`;
              addNotification({
                id: `message:${message.messageId}`,
                kind: 'message',
                groupId: group.id,
                groupName: group.name,
                actorName,
              });
              void media.playMessageNotificationSound();
            }
            const displayMessage = toPeerChatMessage(message, localCloudUserId);
            setCloudMessages((previous) => previous.some((item) => item.id === displayMessage.id)
              ? previous
              : [...previous, displayMessage].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
          },
          onPeerState: (peerId, state) => {
            if (!current) return;
            setPeerStates((previous) => ({ ...previous, [peerId]: state }));
            media.handleRemotePeerState(peerId, state);
          },
          onTrack: media.handleRemoteTrack,
          onError: (_message) => { if (current) setPeerError('Não foi possível conectar aos participantes. Tente novamente.'); },
        });
        meshRef.current = mesh;
        setMeshReady(true);
      } catch (cause) {
        setPeerError(describeError(cause, 'Não foi possível iniciar a conversa do grupo.'));
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
  }, [activeCloudGroup?.id, localCloudUserId, memberGroupId, memberLoading, meshMembers, meshRetryNonce, media.handleRemoteTrack, media.handleRemotePeerState, media.playMessageNotificationSound]);

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
      setNotice('Mensagem salva neste computador. Aguardando participantes.');
    } catch (cause) {
      if (messageId && persistedCloudMessageIds.current.has(messageId)) {
        setDraft('');
        setNotice('Mensagem salva neste computador. A entrega será tentada quando houver conexão.');
      } else {
        setError(describeError(cause, 'Não foi possível enviar a mensagem.'));
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
  const chooseProfilePhoto = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setProfileError('Escolha uma imagem PNG, JPEG ou WebP.');
      return;
    }
    setProfileError('');
    setProfileNotice('');
    setProfilePhotoBusy(true);
    try {
      setProfileAvatarData(await avatarDataFromFile(file));
      setProfileNotice('Foto preparada. Salve o perfil para publicá-la.');
    } catch (cause) {
      setProfileError(describeError(cause, 'Não foi possível preparar a foto de perfil.'));
    } finally {
      setProfilePhotoBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (cloudStatus.state !== 'ready' || profileSaving || profileLoading || profilePhotoBusy) return;
    const displayName = profileName.trim();
    if (Array.from(displayName).length > USER_PROFILE_NAME_MAX_LENGTH) {
      setProfileError(`O nome deve ter até ${USER_PROFILE_NAME_MAX_LENGTH} caracteres.`);
      return;
    }
    setProfileError('');
    setProfileNotice('');
    setProfileSaving(true);
    try {
      const profile = await window.larp.saveMyProfile({
        displayName: displayName || null,
        avatarData: profileAvatarData,
      });
      setMyProfile(profile);
      setCloudMembers((members) => members.map((member) => member.userId === profile.userId ? { ...member, profile } : member));
      setCachedCloudMembers((members) => members.map((member) => member.userId === profile.userId ? { ...member, profile } : member));
      setProfileNotice('Perfil salvo. Visível apenas a membros dos seus grupos em comum.');
    } catch (cause) {
      setProfileError(describeError(cause, 'Não foi possível salvar o perfil.'));
    } finally {
      setProfileSaving(false);
    }
  };

  const startSelectedScreenShare = async () => {
    const source: SelectedDisplaySource | undefined = media.displaySources.find((candidate) => candidate.id === media.selectedDisplaySourceId);
    if (!source) return;
    const started = await media.startScreenShare(source);
    if (started) closeHelp();
  };

  const connectedPeerCount = Object.values(peerStates).filter((state) => state === 'connected').length;
  const connectedPeerLabel = connectedPeerCount === 1 ? '1 participante conectado' : `${connectedPeerCount} participantes conectados`;
  const visibleMembers = activeCloudGroup ? cloudMembers : cachedCloudGroup ? cachedCloudMembers : [];
  const membersLoading = activeCloudGroup ? memberLoading : cachedCloudGroup && cachedHistoryLoading;
  const localParticipantId = activeCloudGroup
    ? localCloudUserId
    : cachedCloudMembers.find((member) => member.publicKey === identity?.publicKey)?.userId;
  const profilesByUserId = new Map(
    visibleMembers.flatMap((member) => member.profile ? [[member.userId, member.profile] as const] : []),
  );
  profilesByUserIdRef.current = profilesByUserId;
  const selfMember = visibleMembers.find((member) => member.userId === localParticipantId
    || member.publicKey === identity?.publicKey);
  const selfProfile = myProfile !== undefined ? myProfile : selfMember?.profile ?? null;
  const profileNameTooLong = Array.from(profileName.trim()).length > USER_PROFILE_NAME_MAX_LENGTH;
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length;
  useEffect(() => {
    const groupId = activeCloudGroup?.id;
    const currentPeerIds = new Set(media.remoteAudioPeerIds);
    const previous = previousRemoteAudioPeerIdsRef.current;
    if (previous.groupId !== groupId) {
      previousRemoteAudioPeerIdsRef.current = { groupId, peerIds: currentPeerIds };
      return;
    }
    if (!groupId || !activeCloudGroup) {
      previousRemoteAudioPeerIdsRef.current = { groupId, peerIds: currentPeerIds };
      return;
    }
    const nextPreviousPeerIds = new Set([...previous.peerIds].filter((peerId) => currentPeerIds.has(peerId)));
    for (const peerId of currentPeerIds) {
      if (previous.peerIds.has(peerId) || media.remotePeerStates[peerId] !== 'connected') continue;
      const actorName = profilesByUserIdRef.current.get(peerId)?.displayName?.trim()
        || `Participante · ${peerId.slice(-6).toUpperCase()}`;
      addNotification({
        id: `call-join:${groupId}:${peerId}:${Date.now()}`,
        kind: 'call-join',
        groupId,
        groupName: activeCloudGroup.name,
        actorName,
      });
      void media.playCallJoinSound();
      nextPreviousPeerIds.add(peerId);
    }
    previousRemoteAudioPeerIdsRef.current = { groupId, peerIds: nextPreviousPeerIds };
  }, [activeCloudGroup?.id, activeCloudGroup?.name, addNotification, media.playCallJoinSound, media.remoteAudioPeerIds, media.remotePeerStates]);
  const callParticipants = [
    ...(media.callActive && localCloudUserId ? [{
      id: localCloudUserId,
      label: 'Você',
      profile: profilesByUserId.get(localCloudUserId),
      isLocal: true,
      isReconnecting: false,
      isSpeaking: media.speakingParticipantIds.includes(localCloudUserId),
    }] : []),
    ...media.remoteAudioPeerIds
      .map((peerId) => {
        const profile = profilesByUserId.get(peerId);
        const peerState = media.remotePeerStates[peerId];
        const isReconnecting = peerState === 'connecting' || peerState === 'disconnected' || peerState === 'failed';
        return {
          id: peerId,
          label: profile?.displayName?.trim() || `Participante · ${peerId.slice(-6).toUpperCase()}`,
          profile,
          isLocal: false,
          isReconnecting,
          isSpeaking: !isReconnecting && media.speakingParticipantIds.includes(peerId),
        };
      }),
  ];
  const openNotification = (notification: AppNotification) => {
    dispatchNotifications({ type: 'read', id: notification.id });
    if (listedCloudGroups.some((group) => group.id === notification.groupId)) selectCloudGroup(notification.groupId);
    notificationsOpenRef.current = false;
    setNotificationsOpen(false);
  };

  return (
    <main className={`app-shell${screenViewerExpanded ? ' app-shell-screen-expanded' : ''}`}>
      <aside className="sidebar" aria-label="Navegação de grupos">
        <div className="brand-row">
          <img className="brand-logo" src={larpWordmarkUrl} alt="Larp" />
          <span className="build-chip">BETA</span>
        </div>

        <div className={`connection-card connection-${cloudStatus.state}`} aria-label={connectionCopy.label}>
          <span className="connection-indicator" />
          <div>
            <strong>{connectionCopy.label}</strong>
            <span>{connectionCopy.description}</span>

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
            <p className="group-empty">Conectando…</p>
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
                <span>{group.memberCount}/6 membros{cachedCloudGroup ? ' · sem conexão' : ''}</span>
              </span>
              {group.id === selectedCloudGroupId && <span className="active-mark" aria-hidden="true" />}
            </button>
          )) : (
            <p className="group-empty">{cloudStatus.state === 'ready' ? 'Nenhum grupo ainda. Crie um ou aceite um convite.' : 'Nenhum grupo salvo neste computador.'}</p>
          )}
        </nav>



        <button className="invite-button" type="button" onClick={openGroupManager}>
          <span className="invite-icon"><Icon name="plus" size={17} /></span>
          <span>{displayCloudGroup ? cloudStatus.state === 'ready' ? 'Convidar pessoas' : 'Histórico somente para leitura' : 'Criar ou entrar em grupo'}</span>
          {activeCloudGroup && activeCloudGroup.role !== 'owner' && <span className="invite-lock"><Icon name="lock" size={13} /></span>}
        </button>

        <div className="sidebar-footer">
          <ProfileAvatar
            className="profile-avatar"
            profile={selfProfile}
            initials={profileInitials(selfProfile?.displayName, identity ? 'PC' : 'L')}
          />
          <div className="profile-copy">
            <strong>{selfProfile?.displayName || (identity ? 'Este computador' : 'Larp')}</strong>
            <span>{selfProfile ? 'Perfil dos grupos em comum' : identity ? 'Identidade protegida neste computador' : 'Identidade indisponível'}</span>
          </div>
          <button
            className="profile-edit"
            type="button"
            disabled={cloudStatus.state !== 'ready'}
            aria-label="Editar perfil"
            title={cloudStatus.state === 'ready' ? 'Editar perfil compartilhado' : 'Conecte-se para editar o perfil'}
            onClick={(event) => void openProfileEditor(event)}
          >
            Editar
          </button>
          <button className="icon-button profile-info" type="button" aria-label="Ver estado da conexão" onClick={openHelp}>
            <Icon name="info" size={17} />
          </button>
        </div>
      </aside>

      <section className="chat-panel" aria-label="Conversa">
        <header className="chat-header">
          <div className="chat-heading">
            <h1>{activeGroup?.name ?? (cloudStatus.state === 'connecting' ? 'Conectando…' : 'Grupos')}</h1>
            <p>{activeCloudGroup ? `${activeCloudGroup.memberCount} membros autorizados` : cachedCloudGroup ? `${cachedCloudGroup.memberCount} membros · somente leitura neste computador` : null}</p>
          </div>
          <div className="header-actions">
            {activeCloudGroup ? (
              <span className="header-local-badge">{connectedPeerLabel}</span>
            ) : cachedCloudGroup ? (
              <span className="header-local-badge">Histórico · somente leitura</span>
            ) : null}
            <button
              className={`icon-button help-trigger notification-trigger${notificationsOpen ? ' notification-trigger-active' : ''}`}
              type="button"
              aria-label={notificationsOpen ? 'Voltar à conversa' : unreadNotificationCount ? `Abrir notificações, ${unreadNotificationCount} não lidas` : 'Abrir notificações'}
              title={notificationsOpen ? 'Voltar à conversa' : 'Notificações'}
              aria-pressed={notificationsOpen}
              onClick={() => {
                const open = !notificationsOpen;
                notificationsOpenRef.current = open;
                setNotificationsOpen(open);
                if (open) dispatchNotifications({ type: 'read-all' });
              }}
            >
              <Icon name="bell" size={18} />
              {unreadNotificationCount > 0 && <span className="notification-badge" aria-hidden="true">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
            </button>
            <button className="icon-button help-trigger appearance-trigger" type="button" aria-label="Personalizar cor da interface" title="Personalizar cor da interface" onClick={openAppearanceSettings}>
              <Icon name="spark" size={18} />
            </button>
            <button className="icon-button help-trigger" type="button" aria-label="Ver estado da conexão" onClick={openHelp}>
              <Icon name="info" size={18} />
            </button>
          </div>
        </header>


        {!activeCloudGroup && cachedCloudGroup && (
          <div className={`offline-banner banner-${cloudStatus.state}`} role="status">
            <span className="banner-icon"><Icon name="lock" size={16} /></span>
            <p><strong>Histórico somente para leitura.</strong> Os dados salvos neste computador não podem ser alterados sem conexão.</p>
            <button type="button" onClick={openHelp}>
              Ver conexão <Icon name="arrow" size={14} />
            </button>
          </div>
        )}


        <section className="message-list" aria-label={notificationsOpen ? 'Notificações' : `Mensagens de ${activeGroup?.name ?? 'grupo'}`} aria-live={!notificationsOpen && !screenViewerExpanded ? 'polite' : 'off'}>
          {notificationsOpen ? (
            <NotificationCenter
              notifications={notifications}
              onOpen={openNotification}
              onClear={() => dispatchNotifications({ type: 'clear' })}
            />
          ) : (
            <>
          {(media.displayStream || media.remoteVideoStream || callParticipants.length > 0) && (
            <section className={`screen-stage${screenViewerExpanded ? ' screen-stage-expanded' : ''}`} aria-label="Palco da chamada">
              <div className="screen-stage-header">
                <div className="screen-stage-heading">
                  <strong>{media.displayStream
                    ? `Você está compartilhando · ${media.shareSourceName}`
                    : media.remoteVideoStream ? 'Tela compartilhada ao vivo' : 'Chamada de voz'}</strong>
                  {callParticipants.length > 0 && (
                    <span>{callParticipants.length} {callParticipants.length === 1 ? 'participante na chamada' : 'participantes na chamada'}</span>
                  )}
                </div>
                {(media.displayStream || media.remoteVideoStream) && (
                  <button
                    ref={screenViewerToggleRef}
                    type="button"
                    className="screen-stage-toggle"
                    aria-label={screenViewerExpanded ? 'Sair da tela cheia em janela' : 'Exibir transmissão em tela cheia na janela'}
                    aria-pressed={screenViewerExpanded}
                    aria-keyshortcuts={screenViewerExpanded ? 'Escape' : undefined}
                    title={screenViewerExpanded ? 'Restaurar janela anterior (Esc)' : 'Maximizar sem ocultar a barra de tarefas'}
                    onClick={() => changeScreenViewerMode(!screenViewerExpanded)}
                  >
                    <Icon name={screenViewerExpanded ? 'shrink' : 'expand'} size={16} />
                    <span>{screenViewerExpanded ? 'Sair da tela cheia' : 'Tela cheia em janela'}</span>
                  </button>
                )}
              </div>
              <div className={`call-stage-layout${media.displayStream || media.remoteVideoStream ? ' call-stage-layout-screen' : ''}${(media.displayStream || media.remoteVideoStream) && callParticipants.length > 0 ? ' call-stage-layout-sharing' : ''}`}>
                {(media.displayStream || media.remoteVideoStream) && (
                  <div className="call-stage-screen">
                    <video ref={media.screenVideoRef} muted={Boolean(media.displayStream)} autoPlay playsInline aria-label={media.displayStream ? 'Prévia da tela compartilhada' : 'Tela compartilhada pelo grupo'} />
                  </div>
                )}
                {callParticipants.length > 0 && (
                  <div className={`call-stage-participants${media.displayStream || media.remoteVideoStream ? ' call-stage-participants-side' : ''}`} aria-label="Participantes na chamada">
                    {callParticipants.map((participant) => (
                      <article
                        className={`call-stage-participant${participant.isSpeaking ? ' call-stage-participant-speaking' : ''}${participant.isReconnecting ? ' call-stage-participant-reconnecting' : ''}`}
                        key={participant.id}
                        aria-label={`${participant.label}, ${participant.isReconnecting ? 'reconectando' : participant.isSpeaking ? 'falando' : 'conectado'}`}
                      >
                        <ProfileAvatar
                          className="call-stage-participant-avatar"
                          profile={participant.profile}
                          initials={profileInitials(participant.profile?.displayName, participant.isLocal ? 'PC' : participant.id.slice(-2).toUpperCase())}
                        />
                        <strong className="call-stage-participant-name">{participant.label}</strong>
                        <span className="call-stage-participant-status">{participant.isReconnecting ? 'Reconectando' : participant.isSpeaking ? 'Falando' : 'Conectado'}</span>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
          {cloudStatus.state === 'connecting' ? (
            <div className="loading-state"><span className="loading-dot" />Carregando grupos…</div>
          ) : displayCloudGroup ? activeCloudGroup ? (
            historyLoading ? (
              <div className="loading-state"><span className="loading-dot" />Abrindo o histórico neste computador…</div>
            ) : cloudMessagesGroupId === activeCloudGroup.id && cloudMessages.length ? (
              <>
                <div className="date-divider"><span>Mensagens anteriores</span></div>
                {cloudMessages.map((message) => (
                  <Message key={message.id} message={message} localParticipantId={localCloudUserId} profile={profilesByUserId.get(message.authorId)} />
                ))}
                <div className="local-note"><span /> O histórico fica armazenado neste computador.</div>
              </>
            ) : peerError ? (
              <div className="empty-state"><Icon name="info" size={22} /><p>{peerError}</p></div>
            ) : (
              <div className="empty-state"><Icon name="bubble" size={22} /><p>{memberLoading ? 'Carregando participantes…' : meshReady ? 'Ainda não há mensagens neste grupo.' : 'Preparando a conversa do grupo…'}</p></div>
            )
          ) : cachedHistoryLoading ? (
            <div className="loading-state"><span className="loading-dot" />Verificando o histórico salvo neste computador…</div>
          ) : cachedHistoryError ? (
            <div className="empty-state"><Icon name="info" size={22} /><p>{cachedHistoryError}</p></div>
          ) : cachedMessages.length ? (
            <>
              <div className="date-divider"><span>Histórico salvo neste computador · somente leitura</span></div>
              {cachedMessages.map((message) => <Message key={message.id} message={message} localParticipantId={localParticipantId} profile={profilesByUserId.get(message.authorId)} />)}
              <div className="local-note"><span /> O histórico fica armazenado neste computador.</div>
            </>
          ) : (
            <div className="empty-state"><Icon name="bubble" size={22} /><p>Não há mensagens deste grupo salvas neste computador.</p></div>
          ) : cloudStatus.state === 'ready' ? (
            <div className="empty-state"><Icon name="users" size={22} /><p>Crie um grupo privado ou aceite um convite para começar.</p><button className="inline-action" type="button" onClick={openGroupManager}>Gerenciar grupos</button></div>
          ) : !cachedGroupsLoaded ? (
            <div className="loading-state"><span className="loading-dot" />Lendo grupos salvos neste computador…</div>
          ) : (
            <div className="empty-state"><Icon name="info" size={22} /><p>{connectionCopy.description}</p><button className="inline-action" type="button" onClick={openHelp}>Ver conexão</button></div>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
            </>
          )}
        </section>


        <div className="chat-bottom">
          <div className={`call-dock${callParticipants.length ? ' call-dock-active' : ''}`} aria-label={`Controles de voz${callParticipants.length ? ` · ${callParticipants.length} na chamada` : ''}`}>
            <div className="call-overview">
              <div className="call-status">
                <span className={`call-status-dot ${callParticipants.length ? 'call-status-live' : ''}`} />
                <span>{callParticipants.length
                  ? `Chamada ativa · ${callParticipants.length} ${callParticipants.length === 1 ? 'participante' : 'participantes'} na chamada`
                  : activeCloudGroup ? `${connectedPeerLabel} · voz desligada` : 'Conecte-se a um grupo para iniciar a chamada'}</span>
              </div>
            </div>

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
              <label className="playback-volume-control">
                <span>Voz</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(media.voicePlaybackVolume * 100)}
                  disabled={!media.mediaReady}
                  aria-label="Volume da voz"
                  onChange={(event) => media.setVoicePlaybackVolume(Number(event.currentTarget.value) / 100)}
                />
                <output aria-hidden="true">{Math.round(media.voicePlaybackVolume * 100)}%</output>
              </label>
              <label className="playback-volume-control">
                <span>Transmissão</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(media.transmissionPlaybackVolume * 100)}
                  disabled={!media.mediaReady || !media.remoteTransmissionAudioAvailable}
                  aria-label="Volume da transmissão"
                  onChange={(event) => media.setTransmissionPlaybackVolume(Number(event.currentTarget.value) / 100)}
                />
                <output aria-hidden="true">{Math.round(media.transmissionPlaybackVolume * 100)}%</output>
              </label>

              <button type="button" className="call-control device-control" disabled={!activeCloudGroup || !media.mediaReady} onClick={openAudioSettings}>Dispositivos</button>
              <button
                type="button"
                className={`call-join ${media.callActive ? 'call-join-leave' : ''}`}
                disabled={!activeCloudGroup || !meshReady || !media.mediaReady || connectedPeerCount === 0 || media.audioBusy}
                title={connectedPeerCount === 0 ? 'A chamada exige ao menos um participante conectado' : 'A voz será compartilhada com os participantes conectados'}
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
            <label className="sr-only" htmlFor="message-input">Mensagem para o grupo</label>
            <textarea
              id="message-input"
              placeholder={activeCloudGroup ? meshReady ? 'Escreva uma mensagem…' : 'Preparando a conversa…' : cachedCloudGroup ? 'Histórico sem conexão · somente leitura' : cloudStatus.state === 'ready' ? 'Selecione um grupo privado para conversar…' : 'Conecte-se a um grupo para enviar mensagens…'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={4000}
              rows={2}
              disabled={!activeCloudGroup || !meshReady || !localCloudUserId || sending}
            />
            <div className="composer-footer">
              <span className="composer-hint">{activeCloudGroup ? meshReady ? 'Salva neste computador' : 'Preparando o grupo' : cachedCloudGroup ? 'Somente leitura' : cloudStatus.state === 'ready' ? 'Selecione um grupo' : 'Envio indisponível'} <span aria-hidden="true">·</span> {draft.length}/4.000</span>
              <button className="send-button" type="submit" disabled={!activeCloudGroup || !meshReady || !localCloudUserId || !draft.trim() || sending}>
                <span>{sending ? 'Enviando…' : activeCloudGroup ? 'Enviar' : cachedCloudGroup ? 'Somente leitura' : 'Sem grupo'}</span>
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
          <p>{activeCloudGroup ? 'Grupo privado · conectado' : cachedCloudGroup ? 'Grupo privado · sem conexão e somente para leitura' : 'Grupos e mensagens aparecem após a conexão.'}</p>
          <span className="summary-tag"><Icon name="lock" size={12} />{activeCloudGroup ? 'GRUPO PRIVADO' : cachedCloudGroup ? 'SEM CONEXÃO · LEITURA' : 'SEM GRUPO'}</span>
        </section>


        <div className="details-divider" />

        <section className="members-section">
          <div className="section-title"><h3>Membros</h3><span>{displayCloudGroup?.memberCount ?? '—'}</span></div>
          <p className="section-caption">{activeCloudGroup ? 'Pessoas com acesso ao grupo' : cachedCloudGroup ? 'Acesso salvo neste computador · somente leitura' : 'Selecione um grupo disponível.'}</p>
          <ul className="member-list">
            {membersLoading && <li className="member-loading">Carregando membros…</li>}
            {visibleMembers.map((member) => {
              const isSelf = member.publicKey === identity?.publicKey
                || (cloudStatus.state === 'ready' && member.userId === cloudStatus.userId);
              const fallbackLabel = isSelf ? 'Este computador' : `Participante · ${member.userId.slice(-6).toUpperCase()}`;
              const label = member.profile?.displayName || fallbackLabel;
              const roleLabel = member.role === 'owner' ? 'Responsável' : 'Membro';
              const presenceForMember = resolveMemberPresence(
                member.userId,
                localCloudUserId,
                localPresenceStatus,
                presenceByUserId,
                Boolean(activeCloudGroup && presenceReady),
              );
              return (
                <li key={member.userId} className="member-row">
                  <ProfileAvatar
                    className={`avatar member-avatar ${isSelf ? 'avatar-local' : ''}`}
                    profile={member.profile}
                    initials={profileInitials(member.profile?.displayName, isSelf ? 'PC' : member.userId.slice(-2).toUpperCase())}
                    presence={presenceForMember}
                  />
                  <span className="member-name"><strong>{label}</strong><span>{roleLabel}</span></span>
                  {activeCloudGroup?.role === 'owner' && !isSelf && (
                    <button className="remove-member" type="button" disabled={Boolean(cloudAction)} aria-label={`Remover ${label}`} title="Remover membro" onClick={() => void removeMember(member)}>
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>


        <section className={`share-card ${media.shareActive ? 'share-card-active' : ''}`}>
          <div className="share-card-icon"><Icon name="screen" size={18} /></div>
          <div><strong>{media.shareActive ? 'Compartilhando tela' : 'Compartilhar tela'}</strong><span>{media.shareActive ? `${media.shareSourceName} · ${media.screenMode === 'motion' ? 'Fluidez' : 'Nitidez'}` : activeCloudGroup ? meshReady ? 'Escolha uma tela ou janela' : 'Aguardando participantes' : 'Disponível em grupos privados'}</span></div>
          <button type="button" disabled={!media.shareActive && (!activeCloudGroup || !meshReady || !media.mediaReady)} aria-label={media.shareActive ? 'Parar compartilhamento de tela' : 'Selecionar tela para compartilhar'} title={media.shareActive ? 'Parar transmissão e liberar a captura' : 'Selecionar explicitamente uma tela ou janela'} onClick={(event) => media.shareActive ? void media.stopScreenShare() : openScreenSettings(event)}>
            <Icon name={media.shareActive ? 'close' : 'chevron'} size={16} />
          </button>
        </section>

        <div className="privacy-note"><Icon name="lock" size={14} /><p>{activeCloudGroup ? 'O histórico de mensagens permanece neste computador.' : cachedCloudGroup ? 'Grupo, membros e mensagens salvos neste computador; somente leitura.' : 'Conecte-se a um grupo para acessar mensagens e participantes.'}</p></div>

      </aside>

      {helpOpen && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHelp(); }}>
          <section className={`connection-dialog ${dialogMode === 'groups' ? 'group-manager-dialog' : dialogMode === 'audio' ? 'audio-settings-dialog' : dialogMode === 'screen' ? 'screen-settings-dialog' : dialogMode === 'profile' ? 'profile-dialog' : dialogMode === 'appearance' ? 'appearance-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title" aria-describedby="connection-dialog-description">
            <button ref={helpCloseRef} className="icon-button dialog-close" type="button" aria-label="Fechar diálogo" onClick={closeHelp}><Icon name="close" size={18} /></button>
            {dialogMode === 'connection' ? (
              <>
                <div className="dialog-mark"><Icon name="lock" size={21} /></div>
                <h2 id="connection-dialog-title">{connectionCopy.label}</h2>
                <p id="connection-dialog-description">{connectionCopy.description}</p>
                <div className="dialog-checklist">
                  <div><span className={identity ? 'check-ready' : 'check-empty'} /><span>Identidade deste computador</span><strong>{identity ? 'Pronta' : 'Indisponível'}</strong></div>
                  <div><span className={cloudStatus.state === 'ready' ? 'check-ready' : 'check-empty'} /><span>Acesso aos grupos</span><strong>{connectionCopy.label}</strong></div>
                  <div><span className={connectedPeerCount ? 'check-ready' : 'check-empty'} /><span>Participantes conectados</span><strong>{connectedPeerCount ? connectedPeerLabel : activeCloudGroup ? meshReady ? 'Ninguém conectado' : 'Verificando' : cachedCloudGroup ? 'Histórico somente para leitura' : 'Sem grupo ativo'}</strong></div>
                </div>
                
                {cloudError && <p className="dialog-error" role="alert">{cloudError}</p>}
                <div className="dialog-actions">
                  <button className="dialog-secondary" type="button" disabled={cloudAction === 'refresh'} onClick={() => void refreshCloudStatus()}>
                    {cloudAction === 'refresh' ? 'Verificando…' : 'Atualizar conexão'}
                  </button>
                  <button className="dialog-secondary" type="button" disabled={!activeCloudGroup || !meshReady || turnStatus === 'checking'} onClick={retryTurn}>Tentar conexão novamente</button>
                  <button className="dialog-done" type="button" onClick={closeHelp}>Fechar</button>
                </div>
              </>
            ) : dialogMode === 'groups' ? (
              <>
                <h2 id="connection-dialog-title">Grupos privados</h2>
                <p id="connection-dialog-description">{cloudStatus.state === 'ready' ? 'Crie um grupo ou entre com um código de convite de uso único.' : connectionCopy.description}</p>
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
            ) : dialogMode === 'appearance' ? (
              <div className="appearance-form">
                <h2 id="connection-dialog-title">Personalizar aparência</h2>
                <p id="connection-dialog-description">Escolha a cor de destaque da interface. A preferência fica salva somente neste computador.</p>
                <label htmlFor="accent-color">Cor de destaque</label>
                <div className="appearance-color-row">
                  <input id="accent-color" type="color" value={accentColor} onChange={(event) => chooseAccentColor(event.currentTarget.value)} />
                  <output htmlFor="accent-color">{accentColor.toUpperCase()}</output>
                </div>
                <div className="dialog-actions">
                  <button className="dialog-secondary" type="button" disabled={accentColor === DEFAULT_ACCENT_COLOR} onClick={restoreDefaultAccentColor}>Restaurar padrão</button>
                  <button className="dialog-done" type="button" onClick={closeHelp}>Fechar</button>
                </div>
              </div>
            ) : dialogMode === 'profile' ? (
              <form className="profile-form" onSubmit={(event) => void saveProfile(event)}>
                <h2 id="connection-dialog-title">Editar perfil</h2>
                <p id="connection-dialog-description">Seu nome e sua foto aparecem apenas para pessoas dos seus grupos em comum.</p>
                {profileLoading && <p className="profile-hint" role="status">Carregando seu perfil…</p>}
                <label htmlFor="profile-display-name">Nome de exibição</label>
                <input
                  id="profile-display-name"
                  className="profile-name-input"
                  type="text"
                  maxLength={USER_PROFILE_NAME_MAX_LENGTH * 2}
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="Como você aparece nos grupos"
                  disabled={cloudStatus.state !== 'ready' || profileLoading || profileSaving}
                  aria-invalid={profileNameTooLong}
                  aria-describedby="profile-name-hint"
                />
                <p className="profile-hint" id="profile-name-hint">
                  Até {USER_PROFILE_NAME_MAX_LENGTH} caracteres. Vazio restaura seu nome padrão.
                </p>
                <label htmlFor="profile-avatar-file">Foto de perfil</label>
                <div className="profile-photo-control">
                  <ProfileAvatar
                    className="profile-avatar profile-avatar-preview"
                    profile={{ userId: localCloudUserId ?? '', displayName: profileName || null, avatarData: profileAvatarData }}
                    initials={profileInitials(profileName, 'PC')}
                  />
                  <div className="profile-photo-actions">
                    <input
                      id="profile-avatar-file"
                      className="profile-file-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={cloudStatus.state !== 'ready' || profileLoading || profilePhotoBusy || profileSaving}
                      onChange={(event) => void chooseProfilePhoto(event.currentTarget)}
                    />
                    <button
                      className="dialog-secondary"
                      type="button"
                      disabled={!profileAvatarData || profilePhotoBusy || profileSaving}
                      onClick={() => { setProfileAvatarData(null); setProfileNotice('Foto removida. Salve o perfil para aplicar.'); }}
                    >
                      Remover foto
                    </button>
                  </div>
                </div>
                <p className="profile-hint">A imagem será ajustada para aparecer bem no perfil.</p>
                {profileError && <p className="dialog-error" role="alert">{profileError}</p>}
                {profileNotice && <p className="dialog-success" role="status">{profileNotice}</p>}
                <div className="dialog-actions profile-actions">
                  <button
                    className="dialog-secondary"
                    type="button"
                    disabled={profileLoading || profilePhotoBusy || profileSaving}
                    onClick={() => { setProfileName(''); setProfileAvatarData(null); setProfileNotice('Perfil limpo. Salve para restaurar o nome padrão.'); }}
                  >
                    Limpar perfil
                  </button>
                  <button
                    className="dialog-done"
                    type="submit"
                    disabled={cloudStatus.state !== 'ready' || profileLoading || profilePhotoBusy || profileSaving || profileNameTooLong}
                  >
                    {profileSaving ? 'Salvando…' : 'Salvar perfil'}
                  </button>
                </div>
              </form>
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
                    <span style={{ transform: `scaleX(${media.microphoneLevel / 100})` }} />
                  </div>
                  <label className="noise-suppression-option">
                    <input
                      type="checkbox"
                      checked={media.noiseSuppressionEnabled}
                      disabled={!media.noiseSuppressionSupported || media.audioBusy || media.callActive || media.microphoneTestActive}
                      onChange={(event) => media.setNoiseSuppression(event.target.checked)}
                    />
                    <span>
                      <strong>Supressão de ruído</strong>
                      <small>{!media.noiseSuppressionSupported
                        ? 'Não há suporte nativo no Chromium deste computador.'
                        : media.callActive || media.microphoneTestActive
                          ? 'Saia da chamada ou pare o teste para alterar. A opção vale na próxima captura.'
                          : 'Reduz ruídos do ambiente; a intensidade é automática e definida pelo Chromium e pelo microfone.'}</small>
                    </span>
                  </label>
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
                <p id="connection-dialog-description">Escolha uma tela ou janela. O áudio do sistema começa desativado e só será incluído se você permitir.</p>
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
                    <label><input type="radio" name="screen-mode" checked={media.screenMode === 'motion'} onChange={() => media.setScreenMode('motion')} /><span><strong>Fluidez</strong><small>Prioriza movimentos suaves e adapta a qualidade à conexão.</small></span></label>
                    <label><input type="radio" name="screen-mode" checked={media.screenMode === 'text'} onChange={() => media.setScreenMode('text')} /><span><strong>Nitidez</strong><small>Prioriza texto legível e adapta a qualidade à conexão.</small></span></label>
                  </fieldset>
                  <label className="system-audio-option"><input type="checkbox" checked={media.includeSystemAudio} onChange={(event) => media.setIncludeSystemAudio(event.target.checked)} /><span>Incluir áudio do sistema <small>Desativado por padrão; depende das permissões deste computador.</small></span></label>
                  <label className="budget-label" htmlFor="video-budget">Ajuste de qualidade da transmissão</label>
                  <input id="video-budget" className="budget-slider" type="range" min={1} max={20} step={1} value={media.videoBudgetMbps} onChange={(event) => media.setVideoBudgetMbps(Number(event.target.value))} aria-label="Qualidade máxima da transmissão" />
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
      <audio ref={media.voiceAudioElementRef} className="sr-only" autoPlay aria-label="Áudio remoto de voz" />
      <audio ref={media.transmissionAudioElementRef} className="sr-only" autoPlay aria-label="Áudio remoto da transmissão" />
    </main>
  );
}

export default App;
