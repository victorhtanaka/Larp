import {
  MAX_ENVELOPE_BYTES,
  MAX_ICE_CANDIDATES_PER_BATCH,
  WEBRTC_PROTOCOL_VERSION,
  parseProtocolEnvelope,
  signProtocolEnvelope,
  validateProtocolEnvelope,
  verifyProtocolEnvelope,
  type IdentitySigner,
  type IdentityVerifier,
  type ProtocolErrorCode,
  type SignedChatEnvelope,
  type SignedDescriptionEnvelope,
  type SignedIceBatchEnvelope,
  type SignedProtocolEnvelope,
  type UnsignedProtocolEnvelope,
} from '../../shared/webrtc-protocol';
import {
  MessageSynchronizer,
  type LocalMessageStore,
  type MessageSyncCallbacks,
  type NewChatMessage,
} from './message-sync';
import type { MeshTrackSender } from '../media/session';

export const MAX_PEER_MESH_SIZE = 5;
const ICE_FLUSH_DELAY_MS = 50;
const DISCONNECT_GRACE_MS = 12_000;
const FAILED_RECONNECT_GRACE_MS = 20_000;
const MAX_PENDING_CANDIDATES = 64;
const MAX_PENDING_NEGOTIATIONS = 8;
const MAX_DATA_CHANNEL_BUFFER = 1024 * 1024;

export type PeerConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface SignalingTransport {
  send(peerId: string, envelope: SignedProtocolEnvelope): Promise<void>;
  subscribe(listener: (transportPeerId: string, message: unknown) => void): () => void;
}

export interface TurnCredentialServer {
  readonly urls: string | readonly string[];
  readonly username: string;
  readonly credential: string;
}

export interface PeerMeshCallbacks extends MessageSyncCallbacks {
  readonly onPeerState?: (peerId: string, status: PeerConnectionStatus) => void;
  readonly onMediaState?: (peerId: string, media: 'voice' | 'screen', active: boolean) => void;
  readonly onDataChannelState?: (peerId: string, state: RTCDataChannelState) => void;
  readonly onTrack?: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
}

export interface PeerMediaSender {
  readonly peerId: string;
  readonly sender: RTCRtpSender;
  readonly connection: RTCPeerConnection;
}

export interface PeerMeshOptions {
  readonly groupId: string;
  readonly localParticipantId: string;
  readonly signaling: SignalingTransport;
  readonly signer: IdentitySigner;
  readonly verifier: IdentityVerifier;
  readonly store: LocalMessageStore;
  readonly isGroupMember: (groupId: string, participantId: string) => Promise<boolean>;
  readonly getGroupMemberIds: (groupId: string) => Promise<readonly string[]>;
  readonly getMemberPublicKey: (groupId: string, participantId: string) => Promise<string | undefined>;
  readonly callbacks?: PeerMeshCallbacks;
  readonly stunServers?: readonly string[];
  /** TURN is used only when explicitly supplied with credentials. No TURN server is inferred or enabled. */
  readonly turnServers?: readonly TurnCredentialServer[];
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

interface RetainedMediaTrack {
  readonly stream: MediaStream;
  readonly peerIds: Set<string>;
}

interface PeerSession {
  readonly peerId: string;
  readonly connection: RTCPeerConnection;
  readonly polite: boolean;
  channel: RTCDataChannel | undefined;
  readonly mediaSenders: Map<MediaStreamTrack, RTCRtpSender>;
  closed: boolean;
  makingOffer: boolean;
  settingRemoteAnswerPending: boolean;
  iceRestartRequested: boolean;
  iceRestartInProgress: boolean;
  localNegotiationId: string | undefined;
  remoteNegotiationIds: Set<string>;
  ignoredNegotiationIds: Set<string>;
  pendingCandidates: Map<string, RTCIceCandidateInit[]>;
  pendingEndOfCandidates: Set<string>;
  iceCandidates: RTCIceCandidateInit[];
  endOfCandidatesPending: boolean;
  iceFlushInProgress: boolean;
  iceTimer: ReturnType<typeof setTimeout> | undefined;
  disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
}

export function buildRtcConfiguration(
  stunServers: readonly string[] = ['stun:stun.l.google.com:19302'],
  turnServers: readonly TurnCredentialServer[] = [],
): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  for (const url of stunServers) {
    if (typeof url !== 'string' || !url.startsWith('stun:') || url.length > 256) {
      throw new Error('Only bounded direct STUN URLs are accepted in stunServers.');
    }
    iceServers.push({ urls: url });
  }
  for (const server of turnServers) {
    const urls = typeof server.urls === 'string' ? [server.urls] : [...server.urls];
    if (urls.length === 0
      || urls.some((url) => typeof url !== 'string' || !/^turns?:/u.test(url) || url.length > 256)
      || typeof server.username !== 'string'
      || server.username.length === 0
      || server.username.length > 256
      || typeof server.credential !== 'string'
      || server.credential.length === 0
      || server.credential.length > 1024) {
      throw new Error('TURN servers require explicit bounded URLs, username, and credentials.');
    }
    iceServers.push({ urls, username: server.username, credential: server.credential });
  }
  return { iceServers };
}

export class PeerMesh implements MeshTrackSender {
  private readonly peers = new Map<string, PeerSession>();
  private readonly retainedTracks = new Map<MediaStreamTrack, RetainedMediaTrack>();
  private readonly trackEndedListeners = new Map<MediaStreamTrack, () => void>();
  private readonly configuration: RTCConfiguration;
  private readonly messageSync: MessageSynchronizer;
  private readonly unsubscribeSignaling: () => void;
  private closed = false;

  constructor(private readonly options: PeerMeshOptions) {
    if (options.signer.participantId !== options.localParticipantId) {
      throw new Error('Peer mesh signer does not match the local participant.');
    }
    this.configuration = buildRtcConfiguration(options.stunServers, options.turnServers);
    this.messageSync = new MessageSynchronizer({
      groupId: options.groupId,
      localParticipantId: options.localParticipantId,
      signer: options.signer,
      verifier: options.verifier,
      store: options.store,
      isGroupMember: options.isGroupMember,
      getGroupMemberIds: options.getGroupMemberIds,
      getMemberPublicKey: options.getMemberPublicKey,
      getPeerIds: () => this.connectedPeerIds,
      sendToPeer: (peerId, envelope) => this.sendToPeer(peerId, envelope),
      callbacks: options.callbacks,
    });
    this.unsubscribeSignaling = options.signaling.subscribe((peerId, message) => {
      void this.receiveSignal(peerId, message).catch(() => {
        this.options.callbacks?.onProtocolError?.(peerId, 'internal-error', 'Signaling message processing failed.');
      });
    });
  }

  get connectedPeerIds(): readonly string[] {
    return [...this.peers.values()]
      .filter((peer) => !peer.closed
        && peer.connection.connectionState === 'connected'
        && peer.channel?.readyState === 'open')
      .map((peer) => peer.peerId);
  }

  getMediaSenders(): readonly PeerMediaSender[] {
    const mediaSenders: PeerMediaSender[] = [];
    for (const peer of this.peers.values()) {
      if (peer.closed) continue;
      for (const sender of peer.mediaSenders.values()) {
        mediaSenders.push({ peerId: peer.peerId, sender, connection: peer.connection });
      }
    }
    return mediaSenders;
  }

  async connect(peerId: string): Promise<void> {
    this.assertOpen();
    if (peerId === this.options.localParticipantId) throw new Error('Cannot connect a participant to itself.');
    if (!await this.options.isGroupMember(this.options.groupId, peerId)) {
      throw new Error('Remote participant is not a member of this group.');
    }
    const peer = this.ensurePeer(peerId);
    this.options.callbacks?.onPeerState?.(peerId, 'connecting');
    if (this.ownsDataChannel(peerId)) {
      this.createLocalDataChannel(peer);
      await this.negotiate(peer);
    } else {
      await this.sendConnectRequest(peerId);
    }
  }

  async sendMessage(message: NewChatMessage): Promise<SignedChatEnvelope> {
    this.assertOpen();
    return this.messageSync.publish(message);
  }

  async sendMediaState(peerId: string, media: 'voice' | 'screen', active: boolean): Promise<void> {
    this.assertOpen();
    if (peerId === this.options.localParticipantId) throw new Error('Cannot signal media state to the local participant.');
    await this.sendSignal(peerId, {
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'media-state',
      groupId: this.options.groupId,
      senderId: this.options.localParticipantId,
      recipientId: peerId,
      media,
      active,
    });
  }


  attachTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): void {
    this.assertOpen();
    if (peerId === this.options.localParticipantId) throw new Error('Cannot attach a track to the local participant.');
    if (track.readyState !== 'live') return;

    const peer = this.peers.get(peerId);
    if (!peer || peer.closed) throw new Error('Peer is not available for media attachment.');
    if (peer.mediaSenders.has(track)) return;
    let retained = this.retainedTracks.get(track);
    if (!retained) {
      retained = { stream, peerIds: new Set() };
      this.retainedTracks.set(track, retained);
      const onEnded = () => this.discardEndedTrack(track);
      this.trackEndedListeners.set(track, onEnded);
      track.addEventListener('ended', onEnded, { once: true });
    }
    retained.peerIds.add(peerId);
    try {
      const sender = peer.connection.addTrack(track, retained.stream);
      peer.mediaSenders.set(track, sender);
    } catch (error) {
      retained.peerIds.delete(peerId);
      if (retained.peerIds.size === 0) this.releaseRetainedTrack(track);
      throw error;
    }
  }

  detachTrack(peerId: string, track: MediaStreamTrack): void {
    const peer = this.peers.get(peerId);
    const sender = peer?.mediaSenders.get(track);
    if (peer && sender) {
      peer.mediaSenders.delete(track);
      if (!peer.closed && peer.connection.signalingState !== 'closed') peer.connection.removeTrack(sender);
    }
    const retained = this.retainedTracks.get(track);
    retained?.peerIds.delete(peerId);
    if (retained && retained.peerIds.size === 0) this.releaseRetainedTrack(track);
  }

  async restartIce(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || peer.closed) throw new Error('Peer is not available for an ICE restart.');
    peer.iceRestartRequested = true;
    peer.iceRestartInProgress = true;
    peer.connection.restartIce();
    await this.negotiate(peer);
  }
  async closePeer(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.disposePeer(peer, 'closed');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSignaling();
    for (const peer of [...this.peers.values()]) this.disposePeer(peer, 'closed');
    for (const track of this.retainedTracks.keys()) this.releaseRetainedTrack(track);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Peer mesh is closed.');
  }

  private ownsDataChannel(peerId: string): boolean {
    return this.options.localParticipantId < peerId;
  }
  private ensurePeer(peerId: string): PeerSession {
    const existing = this.peers.get(peerId);
    if (existing && !existing.closed) return existing;
    if (this.peers.size >= MAX_PEER_MESH_SIZE) {
      throw new RangeError(`Peer mesh is limited to ${MAX_PEER_MESH_SIZE} peers.`);
    }
    const connection = (this.options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration)))(this.configuration);
    const peer: PeerSession = {
      peerId,
      connection,
      polite: this.options.localParticipantId > peerId,
      channel: undefined,
      mediaSenders: new Map(),
      closed: false,
      makingOffer: false,
      settingRemoteAnswerPending: false,
      iceRestartRequested: false,
      iceRestartInProgress: false,
      localNegotiationId: undefined,
      remoteNegotiationIds: new Set(),
      ignoredNegotiationIds: new Set(),
      pendingCandidates: new Map(),
      pendingEndOfCandidates: new Set(),
      iceCandidates: [],
      endOfCandidatesPending: false,
      iceFlushInProgress: false,
      iceTimer: undefined,
      disconnectedTimer: undefined,
    };
    this.peers.set(peerId, peer);
    connection.ondatachannel = (event) => this.bindDataChannel(peer, event.channel);
    connection.onicecandidate = (event) => this.collectIceCandidate(peer, event.candidate);
    connection.ontrack = (event) => {
      if (!peer.closed) this.options.callbacks?.onTrack?.(peer.peerId, event.track, event.streams);
    };
    connection.onnegotiationneeded = () => {
      void this.negotiate(peer).catch(() => this.failPeer(peer, 'internal-error', 'Unable to negotiate peer connection.'));
    };
    connection.onconnectionstatechange = () => this.connectionStateChanged(peer);
    connection.onsignalingstatechange = () => {
      if (!peer.closed && peer.iceRestartRequested && connection.signalingState === 'stable') {
        void this.negotiate(peer);
      }
    };
    connection.oniceconnectionstatechange = () => this.iceStateChanged(peer);
    for (const [track, retained] of this.retainedTracks) {
      if (track.readyState !== 'live') {
        this.discardEndedTrack(track);
        continue;
      }
      const sender = connection.addTrack(track, retained.stream);
      peer.mediaSenders.set(track, sender);
      retained.peerIds.add(peerId);
    }
    return peer;
  }

  private discardEndedTrack(track: MediaStreamTrack): void {
    if (!this.retainedTracks.has(track)) return;
    for (const peer of this.peers.values()) {
      const sender = peer.mediaSenders.get(track);
      if (!sender) continue;
      peer.mediaSenders.delete(track);
      if (!peer.closed && peer.connection.signalingState !== 'closed') peer.connection.removeTrack(sender);
    }
    this.releaseRetainedTrack(track);
  }

  private releaseRetainedTrack(track: MediaStreamTrack): void {
    this.retainedTracks.delete(track);
    const listener = this.trackEndedListeners.get(track);
    if (listener) track.removeEventListener('ended', listener);
    this.trackEndedListeners.delete(track);
  }

  private createLocalDataChannel(peer: PeerSession): void {
    if (peer.closed || peer.channel) return;
    const channel = peer.connection.createDataChannel('larp-chat', { ordered: true });
    this.bindDataChannel(peer, channel);
  }

  private bindDataChannel(peer: PeerSession, channel: RTCDataChannel): void {
    if (peer.closed) {
      channel.close();
      return;
    }
    if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      this.failPeer(peer, 'malformed-envelope', 'Only reliable ordered data channels are accepted.');
      return;
    }
    if (peer.channel && peer.channel !== channel && peer.channel.readyState !== 'closed') {
      channel.close();
      return;
    }
    peer.channel = channel;
    channel.onopen = () => {
      this.options.callbacks?.onDataChannelState?.(peer.peerId, channel.readyState);
      if (peer.connection.connectionState === 'connected') this.synchronizePeer(peer.peerId);
    };
    channel.onclose = () => {
      this.options.callbacks?.onDataChannelState?.(peer.peerId, channel.readyState);
      if (peer.channel === channel && !peer.closed) this.disposePeer(peer, 'closed');
    };
    channel.onerror = () => {
      this.options.callbacks?.onProtocolError?.(peer.peerId, 'transport-closed', 'Reliable data channel reported a transport error.');
    };
    channel.onmessage = (event) => {
      void this.messageSync.receive(peer.peerId, event.data).catch(() => {
        this.options.callbacks?.onProtocolError?.(peer.peerId, 'internal-error', 'Data channel message processing failed.');
      });
    };
  }
  private synchronizePeer(peerId: string): void {
    void this.messageSync.synchronizePeer(peerId).catch(() => {
      this.options.callbacks?.onProtocolError?.(peerId, 'sync-unavailable', 'Unable to read the durable message range.');
    });
  }

  private connectionStateChanged(peer: PeerSession): void {
    if (peer.closed) return;
    const state = peer.connection.connectionState;
    if (state === 'connected') {
      if (peer.disconnectedTimer) clearTimeout(peer.disconnectedTimer);
      peer.disconnectedTimer = undefined;
      peer.iceRestartInProgress = false;
      this.options.callbacks?.onPeerState?.(peer.peerId, 'connected');
      if (peer.channel?.readyState === 'open') this.synchronizePeer(peer.peerId);
    } else if (state === 'connecting') {
      this.options.callbacks?.onPeerState?.(peer.peerId, 'connecting');
    } else if (state === 'disconnected') {
      this.options.callbacks?.onPeerState?.(peer.peerId, 'disconnected');
      this.scheduleDisposal(peer, DISCONNECT_GRACE_MS);
    } else if (state === 'failed') {
      this.options.callbacks?.onPeerState?.(peer.peerId, 'failed');
      if (!peer.iceRestartInProgress) {
        peer.iceRestartInProgress = true;
        void this.restartIce(peer.peerId).catch(() => undefined);
      }
      this.scheduleDisposal(peer, FAILED_RECONNECT_GRACE_MS);
    } else if (state === 'closed') {
      this.disposePeer(peer, 'closed');
    }
  }

  private iceStateChanged(peer: PeerSession): void {
    if (peer.closed) return;
    const state = peer.connection.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      peer.iceRestartInProgress = false;
      return;
    }
    if (state !== 'failed' || peer.iceRestartInProgress) return;
    peer.iceRestartInProgress = true;
    void this.restartIce(peer.peerId).catch(() => undefined);
  }
  private scheduleDisposal(peer: PeerSession, delay: number): void {
    if (peer.disconnectedTimer) clearTimeout(peer.disconnectedTimer);
    peer.disconnectedTimer = setTimeout(() => {
      if (peer.closed) return;
      const state = peer.connection.connectionState;
      if (state !== 'connected') this.disposePeer(peer, 'closed');
    }, delay);
  }

  private disposePeer(peer: PeerSession, finalState: PeerConnectionStatus): void {
    if (peer.closed) return;
    peer.closed = true;
    if (peer.iceTimer) clearTimeout(peer.iceTimer);
    if (peer.disconnectedTimer) clearTimeout(peer.disconnectedTimer);
    peer.iceTimer = undefined;
    peer.disconnectedTimer = undefined;
    peer.mediaSenders.clear();
    this.peers.delete(peer.peerId);
    this.messageSync.peerClosed(peer.peerId);
    peer.channel?.close();
    peer.connection.close();
    this.options.callbacks?.onDataChannelState?.(peer.peerId, 'closed');
    this.options.callbacks?.onPeerState?.(peer.peerId, finalState);
  }

  private async negotiate(peer: PeerSession): Promise<void> {
    if (peer.closed || peer.makingOffer) return;
    if (peer.connection.signalingState !== 'stable') return;
    peer.makingOffer = true;
    const negotiationId = crypto.randomUUID();
    peer.localNegotiationId = negotiationId;
    try {
      const offer = await peer.connection.createOffer(peer.iceRestartRequested ? { iceRestart: true } : undefined);
      if (peer.localNegotiationId !== negotiationId || peer.closed || peer.connection.signalingState !== 'stable') return;
      await peer.connection.setLocalDescription(offer);
      if (peer.localNegotiationId !== negotiationId) return;
      peer.iceRestartRequested = false;
      const description = peer.connection.localDescription;
      if (!description || (description.type !== 'offer' && description.type !== 'answer')) {
        throw new Error('Peer did not produce a local offer.');
      }
      await this.sendSignal(peer.peerId, {
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'description',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        recipientId: peer.peerId,
        negotiationId,
        description: { type: description.type, sdp: description.sdp ?? '' },
      });
    } catch {
      this.failPeer(peer, 'internal-error', 'Unable to create or send an SDP offer.');
    } finally {
      peer.makingOffer = false;
      if (!peer.closed && peer.iceRestartRequested && peer.connection.signalingState === 'stable') {
        void this.negotiate(peer);
      }
    }
  }

  private async receiveSignal(transportPeerId: string, raw: unknown): Promise<void> {
    if (this.closed) return;
    if (transportPeerId === this.options.localParticipantId) {
      this.options.callbacks?.onProtocolError?.(transportPeerId, 'unauthorized-sender', 'Cannot signal a connection to the local participant.');
      return;
    }
    const parsed = typeof raw === 'string' ? parseProtocolEnvelope(raw) : validateProtocolEnvelope(raw);
    if (!parsed.ok) {
      this.options.callbacks?.onProtocolError?.(transportPeerId, parsed.code, 'Rejected malformed or incompatible signaling data.');
      return;
    }
    const envelope = parsed.envelope;
    if (envelope.kind !== 'description'
      && envelope.kind !== 'ice-batch'
      && envelope.kind !== 'connect-request'
      && envelope.kind !== 'protocol-error'
      && envelope.kind !== 'media-state') {
      return;
    }
    if (envelope.senderId !== transportPeerId
      || envelope.groupId !== this.options.groupId
      || !('recipientId' in envelope)
      || envelope.recipientId !== this.options.localParticipantId) {
      await this.sendSignalError(transportPeerId, 'unauthorized-sender', 'Signaling sender, recipient, or group is not authorized.');
      return;
    }
    if (!await this.options.isGroupMember(envelope.groupId, envelope.senderId)) {
      await this.sendSignalError(transportPeerId, 'unauthorized-sender', 'Signaling peer is not authorized for this group.');
      return;
    }
    const publicKey = await this.options.getMemberPublicKey(envelope.groupId, envelope.senderId);
    if (!publicKey || !await verifyProtocolEnvelope(envelope, this.options.verifier, publicKey)) {
      await this.sendSignalError(transportPeerId, 'invalid-signature', 'Signaling signature is invalid.');
      return;
    }
    if (envelope.kind === 'protocol-error') {
      this.options.callbacks?.onProtocolError?.(transportPeerId, envelope.code, envelope.detail);
      return;
    }
    if (envelope.kind === 'media-state') {
      this.options.callbacks?.onMediaState?.(transportPeerId, envelope.media, envelope.active);
      return;
    }
    if (!this.peers.has(transportPeerId) && this.peers.size >= MAX_PEER_MESH_SIZE) {
      await this.sendSignalError(transportPeerId, 'peer-limit-exceeded', `Peer mesh is limited to ${MAX_PEER_MESH_SIZE} peers.`);
      return;
    }
    const peer = this.ensurePeer(transportPeerId);


    if (envelope.kind === 'connect-request') {
      if (!this.ownsDataChannel(transportPeerId)) {
        await this.sendSignalError(transportPeerId, 'malformed-envelope', 'Only the deterministic channel owner may accept a connection request.');
        return;
      }
      this.createLocalDataChannel(peer);
      await this.negotiate(peer);
    } else if (envelope.kind === 'description') {
      await this.receiveDescription(peer, envelope);
    } else {
      await this.receiveIceBatch(peer, envelope);
    }
  }

  private async receiveDescription(peer: PeerSession, envelope: SignedDescriptionEnvelope): Promise<void> {
    const connection = peer.connection;
    const { description, negotiationId } = envelope;
    if (peer.remoteNegotiationIds.has(negotiationId)) return;
    const readyForOffer = !peer.makingOffer
      && (connection.signalingState === 'stable' || peer.settingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;
    if (offerCollision && !peer.polite) {
      this.rememberNegotiation(peer.ignoredNegotiationIds, negotiationId);
      return;
    }
    if (offerCollision && peer.polite) {
      if (peer.localNegotiationId) this.rememberNegotiation(peer.ignoredNegotiationIds, peer.localNegotiationId);
      if (connection.signalingState !== 'stable') {
        await connection.setLocalDescription({ type: 'rollback' });
      }
      peer.localNegotiationId = undefined;
      peer.makingOffer = false;
    }
    if (description.type === 'answer') {
      if (negotiationId !== peer.localNegotiationId) {
        if (peer.ignoredNegotiationIds.has(negotiationId)) return;
        await this.sendSignalError(peer.peerId, 'malformed-envelope', 'SDP answer does not match the active negotiation.');
        return;
      }
      peer.settingRemoteAnswerPending = true;
    }
    try {
      await connection.setRemoteDescription(description);
    } finally {
      peer.settingRemoteAnswerPending = false;
    }
    this.rememberNegotiation(peer.remoteNegotiationIds, negotiationId);
    await this.applyPendingCandidates(peer, negotiationId);
    if (description.type === 'offer') {
      peer.localNegotiationId = negotiationId;
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const localDescription = connection.localDescription;
      if (!localDescription || localDescription.type !== 'answer') {
        throw new Error('Peer did not produce a local answer.');
      }
      await this.sendSignal(peer.peerId, {
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'description',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        recipientId: peer.peerId,
        negotiationId,
        description: { type: 'answer', sdp: localDescription.sdp ?? '' },
      });
    }
  }

  private async receiveIceBatch(peer: PeerSession, envelope: SignedIceBatchEnvelope): Promise<void> {
    if (peer.ignoredNegotiationIds.has(envelope.negotiationId)) return;
    if (peer.remoteNegotiationIds.has(envelope.negotiationId)) {
      await this.addCandidates(peer, envelope.candidates, envelope.endOfCandidates);
      return;
    }
    let candidates = peer.pendingCandidates.get(envelope.negotiationId);
    if (!candidates) {
      if (peer.pendingCandidates.size >= MAX_PENDING_NEGOTIATIONS) {
        await this.sendSignalError(peer.peerId, 'oversized-envelope', 'Too many ICE negotiations arrived before SDP.');
        return;
      }
      candidates = [];
      peer.pendingCandidates.set(envelope.negotiationId, candidates);
    }
    if (candidates.length + envelope.candidates.length > MAX_PENDING_CANDIDATES) {
      peer.pendingCandidates.delete(envelope.negotiationId);
      peer.pendingEndOfCandidates.delete(envelope.negotiationId);
      await this.sendSignalError(peer.peerId, 'oversized-envelope', 'Pending ICE candidate limit exceeded.');
      return;
    }
    candidates.push(...envelope.candidates);
    if (envelope.endOfCandidates) peer.pendingEndOfCandidates.add(envelope.negotiationId);
  }

  private async applyPendingCandidates(peer: PeerSession, negotiationId: string): Promise<void> {
    const candidates = peer.pendingCandidates.get(negotiationId) ?? [];
    const ended = peer.pendingEndOfCandidates.has(negotiationId);
    peer.pendingCandidates.delete(negotiationId);
    peer.pendingEndOfCandidates.delete(negotiationId);
    await this.addCandidates(peer, candidates, ended);
  }

  private async addCandidates(
    peer: PeerSession,
    candidates: readonly RTCIceCandidateInit[],
    endOfCandidates: boolean,
  ): Promise<void> {
    try {
      for (const candidate of candidates) await peer.connection.addIceCandidate(candidate);
      if (endOfCandidates) await peer.connection.addIceCandidate(null);
    } catch {
      this.options.callbacks?.onProtocolError?.(peer.peerId, 'malformed-envelope', 'Remote ICE candidates could not be applied.');
    }
  }

  private collectIceCandidate(peer: PeerSession, candidate: RTCIceCandidate | null): void {
    if (peer.closed) return;
    if (candidate) {
      if (candidate.candidate.length > 0) peer.iceCandidates.push(candidate.toJSON());
    } else {
      peer.endOfCandidatesPending = true;
    }
    if (peer.iceCandidates.length >= MAX_ICE_CANDIDATES_PER_BATCH || peer.endOfCandidatesPending) {
      void this.flushIce(peer);
      return;
    }
    if (!peer.iceTimer) {
      peer.iceTimer = setTimeout(() => {
        peer.iceTimer = undefined;
        void this.flushIce(peer);
      }, ICE_FLUSH_DELAY_MS);
    }
  }

  private async flushIce(peer: PeerSession): Promise<void> {
    if (peer.iceTimer) clearTimeout(peer.iceTimer);
    peer.iceTimer = undefined;
    if (peer.closed || peer.iceFlushInProgress) return;
    peer.iceFlushInProgress = true;
    try {
      while (!peer.closed && peer.localNegotiationId
        && (peer.iceCandidates.length > 0 || peer.endOfCandidatesPending)) {
        const negotiationId = peer.localNegotiationId;
        const candidates = peer.iceCandidates.splice(0, MAX_ICE_CANDIDATES_PER_BATCH);
        const endOfCandidates = peer.endOfCandidatesPending && peer.iceCandidates.length === 0;
        if (endOfCandidates) peer.endOfCandidatesPending = false;
        await this.sendSignal(peer.peerId, {
          version: WEBRTC_PROTOCOL_VERSION,
          kind: 'ice-batch',
          groupId: this.options.groupId,
          senderId: this.options.localParticipantId,
          recipientId: peer.peerId,
          negotiationId,
          candidates,
          endOfCandidates,
        });
      }
    } catch {
      if (!peer.closed) this.failPeer(peer, 'transport-closed', 'Unable to send ICE candidate batch.');
    } finally {
      peer.iceFlushInProgress = false;
    }
  }

  private async sendConnectRequest(peerId: string): Promise<void> {
    await this.sendSignal(peerId, {
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'connect-request',
      groupId: this.options.groupId,
      senderId: this.options.localParticipantId,
      recipientId: peerId,
    });
  }

  private async sendSignal(peerId: string, payload: UnsignedProtocolEnvelope): Promise<void> {
    const envelope = await signProtocolEnvelope(payload, this.options.signer);
    const validation = validateProtocolEnvelope(envelope);
    if (!validation.ok) throw new Error(`Outgoing signaling envelope rejected: ${validation.code}.`);
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > MAX_ENVELOPE_BYTES) {
      throw new Error('Outgoing signaling envelope exceeds the protocol size limit.');
    }
    await this.options.signaling.send(peerId, envelope);
  }

  private async sendSignalError(peerId: string, code: ProtocolErrorCode, detail: string): Promise<void> {
    if (peerId === this.options.localParticipantId) return;
    try {
      await this.sendSignal(peerId, {
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'protocol-error',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        recipientId: peerId,
        code,
        detail,
      });
    } catch {
      this.options.callbacks?.onProtocolError?.(peerId, code, detail);
    }
  }

  private failPeer(peer: PeerSession, code: ProtocolErrorCode, detail: string): void {
    if (peer.closed) return;
    this.options.callbacks?.onProtocolError?.(peer.peerId, code, detail);
    this.disposePeer(peer, 'closed');
  }

  private rememberNegotiation(set: Set<string>, negotiationId: string): void {
    set.add(negotiationId);
    while (set.size > MAX_PENDING_NEGOTIATIONS) set.delete(set.values().next().value!);
  }

  private async sendToPeer(peerId: string, envelope: SignedProtocolEnvelope): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || peer.closed || peer.connection.connectionState !== 'connected'
      || peer.channel?.readyState !== 'open') {
      throw new Error('Peer transport is not connected.');
    }
    const validation = validateProtocolEnvelope(envelope);
    if (!validation.ok) throw new Error(`Refusing invalid protocol envelope: ${validation.code}.`);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    if (bytes > MAX_ENVELOPE_BYTES) throw new Error('Protocol envelope exceeds the transport limit.');
    if (peer.channel.bufferedAmount > MAX_DATA_CHANNEL_BUFFER) {
      throw new Error('Peer data channel is backpressured.');
    }
    peer.channel.send(JSON.stringify(envelope));
  }
}
