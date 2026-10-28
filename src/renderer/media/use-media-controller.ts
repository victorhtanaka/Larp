import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedDisplaySource } from '../../shared/contracts';
import { MediaQualityController, type VideoContentPreference } from './quality';
import { MediaSession, supportsNoiseSuppression, type MediaDeviceOption } from './session';
import type { PeerConnectionStatus, PeerMesh } from '../rtc/peer-mesh';
import {
  DEFAULT_TRANSMISSION_PLAYBACK_VOLUME,
  DEFAULT_VOICE_PLAYBACK_VOLUME,
  loadTransmissionPlaybackVolume,
  loadVoicePlaybackVolume,
  normalizePlaybackVolume,
  loadVoiceParticipantVolumes,
  saveTransmissionPlaybackVolume,
  saveVoiceParticipantVolumes,
  saveVoicePlaybackVolume,
} from './playback-volume';
import { DEFAULT_NOISE_SUPPRESSION, loadNoiseSuppression, saveNoiseSuppression } from './noise-suppression';
import { RemoteAudioParticipants, type RemoteAudioSourceChange } from './remote-audio-participants';
import { VoiceActivityMonitor } from './voice-activity';

interface MediaControllerOptions {
  groupId?: string;
  mesh: PeerMesh | null;
  connectedPeerIds: readonly string[];
  localParticipantId?: string;
}

export function useMediaController({ groupId, mesh, connectedPeerIds, localParticipantId }: MediaControllerOptions) {
  const [mediaReady, setMediaReady] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState('');
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [callActive, setCallActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [playbackMuted, setPlaybackMuted] = useState(false);
  const [voicePlaybackVolume, setVoicePlaybackVolumeState] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_VOICE_PLAYBACK_VOLUME;
    try {
      return loadVoicePlaybackVolume(window.localStorage);
    } catch {
      return DEFAULT_VOICE_PLAYBACK_VOLUME;
    }
  });
  const [voiceParticipantVolumes, setVoiceParticipantVolumesState] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      return loadVoiceParticipantVolumes(window.localStorage);
    } catch {
      return {};
    }
  });
  const [transmissionPlaybackVolume, setTransmissionPlaybackVolumeState] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_TRANSMISSION_PLAYBACK_VOLUME;
    try {
      return loadTransmissionPlaybackVolume(window.localStorage);
    } catch {
      return DEFAULT_TRANSMISSION_PLAYBACK_VOLUME;
    }
  });
  const [noiseSuppressionEnabled, setNoiseSuppressionState] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_NOISE_SUPPRESSION;
    try {
      return loadNoiseSuppression(window.localStorage);
    } catch {
      return DEFAULT_NOISE_SUPPRESSION;
    }
  });
  const [noiseSuppressionSupported, setNoiseSuppressionSupported] = useState(false);
  const [microphoneTestActive, setMicrophoneTestActive] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [displaySources, setDisplaySources] = useState<SelectedDisplaySource[]>([]);
  const [selectedDisplaySourceId, setSelectedDisplaySourceId] = useState('');
  const [includeSystemAudio, setIncludeSystemAudio] = useState(false);
  const [screenMode, setScreenMode] = useState<VideoContentPreference>('motion');
  const [videoBudgetMbps, setVideoBudgetMbpsState] = useState(20);
  const [shareActive, setShareActive] = useState(false);
  const [shareSourceName, setShareSourceName] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareStarting, setShareStarting] = useState(false);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);

  const [remoteAudioPeerIds, setRemoteAudioPeerIds] = useState<string[]>([]);
  const [speakingParticipantIds, setSpeakingParticipantIds] = useState<string[]>([]);
  const [remotePeerStates, setRemotePeerStates] = useState<Record<string, PeerConnectionStatus>>({});
  const sessionRef = useRef<MediaSession | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioParticipantsRef = useRef(new RemoteAudioParticipants());
  const remoteVoiceAudioStreamsByPeerRef = useRef(new Map<string, MediaStream>());
  const remoteTransmissionAudioStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoStreamsByPeerRef = useRef(new Map<string, MediaStream>());
  const inactiveScreenStreamIdsRef = useRef(new Map<string, Set<string>>());
  const remoteMediaStateRef = useRef(new Map<string, { voice?: boolean; screen?: boolean }>());
  const voiceSignaledPeersRef = useRef(new Set<string>());
  const screenSignaledPeersRef = useRef(new Set<string>());
  const voiceActivityRef = useRef<VoiceActivityMonitor | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const transmissionAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const currentMediaContextRef = useRef({ groupId, mesh });
  currentMediaContextRef.current = { groupId, mesh };
  const sessionOwnerRef = useRef<{ session: MediaSession; groupId?: string; mesh: PeerMesh } | null>(null);
  const callOperationIdRef = useRef(0);
  const shareOperationIdRef = useRef(0);
  const shareGroupIdRef = useRef<string | null>(null);
  const microphoneTestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shareStartingRef = useRef(false);
  const callActiveRef = useRef(false);
  const configuredSendersRef = useRef(new WeakSet<RTCRtpSender>());
  const qualityControllerRef = useRef(new MediaQualityController());

  const voiceParticipantVolumesRef = useRef(voiceParticipantVolumes);
  voiceParticipantVolumesRef.current = voiceParticipantVolumes;
  callActiveRef.current = callActive;
  const isCurrentSession = useCallback((session: MediaSession) => {
    const owner = sessionOwnerRef.current;
    return Boolean(owner
      && owner.session === session
      && sessionRef.current === session
      && currentMediaContextRef.current.groupId === owner.groupId
      && currentMediaContextRef.current.mesh === owner.mesh);
  }, []);
  const signalMediaState = useCallback((peerId: string, media: 'voice' | 'screen', active: boolean) => {
    const signaledPeers = media === 'voice' ? voiceSignaledPeersRef.current : screenSignaledPeersRef.current;
    if (active) {
      if (signaledPeers.has(peerId)) return;
      signaledPeers.add(peerId);
    } else {
      signaledPeers.delete(peerId);
    }
    const activeMesh = currentMediaContextRef.current.mesh;
    if (!activeMesh) return;
    void activeMesh.sendMediaState(peerId, media, active).catch(() => {
      if (active) signaledPeers.delete(peerId);
    });
  }, []);

  const signalMediaStateToPeers = useCallback((
    peerIds: readonly string[],
    media: 'voice' | 'screen',
    active: boolean,
  ) => {
    for (const peerId of peerIds) signalMediaState(peerId, media, active);
  }, [signalMediaState]);


  const refreshRemoteAudioOutputs = useCallback(() => {
    const session = sessionRef.current;
    for (const [peerId, stream] of remoteVoiceAudioStreamsByPeerRef.current) {
      const volume = voiceParticipantVolumesRef.current[peerId];
      if (volume !== undefined) session?.setVoiceParticipantVolume(peerId, volume);
      if (stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        void session?.setVoiceOutput(peerId, stream).catch(() => setAudioError('Permita a saída de áudio para ouvir a chamada.'));
      } else {
        session?.removeVoiceOutput(peerId);
      }
    }
    const transmissionStream = remoteTransmissionAudioStreamRef.current;
    const transmissionOutput = transmissionAudioElementRef.current;
    if (transmissionOutput) {
      if (transmissionOutput.srcObject !== transmissionStream) transmissionOutput.srcObject = transmissionStream;
      if (transmissionStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        void transmissionOutput.play().catch(() => setAudioError('Permita a saída de áudio para ouvir a transmissão.'));
      }
    }
  }, []);

  const clearRemoteAudioChannels = useCallback(() => {
    for (const record of remoteAudioParticipantsRef.current.records) {
      if (record.source === 'voice') voiceActivityRef.current?.removeTrack(record.track);
    }
    for (const peerId of remoteVoiceAudioStreamsByPeerRef.current.keys()) sessionRef.current?.removeVoiceOutput(peerId);
    remoteVoiceAudioStreamsByPeerRef.current.clear();
    remoteAudioParticipantsRef.current.clear();
    remoteVideoStreamsByPeerRef.current.clear();
    remoteMediaStateRef.current.clear();
    inactiveScreenStreamIdsRef.current.clear();
    voiceSignaledPeersRef.current.clear();
    screenSignaledPeersRef.current.clear();
    remoteTransmissionAudioStreamRef.current = null;
    setRemoteAudioPeerIds([]);
    setRemotePeerStates({});
    if (transmissionAudioElementRef.current) transmissionAudioElementRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!groupId || !mesh) {
      voiceActivityRef.current = null;
      setSpeakingParticipantIds([]);
      return;
    }
    let active = true;
    const monitor = new VoiceActivityMonitor({
      onActiveSpeakers: (ids) => {
        if (active) setSpeakingParticipantIds([...ids].sort());
      },
    });
    voiceActivityRef.current = monitor;
    const timer = setInterval(() => monitor.sample(), 100);
    return () => {
      active = false;
      clearInterval(timer);
      if (voiceActivityRef.current === monitor) voiceActivityRef.current = null;
      void monitor.close();
    };
  }, [groupId, mesh]);

  const releaseShareLease = useCallback(async (expectedGroupId?: string) => {
    const leaseGroupId = shareGroupIdRef.current;
    if (!leaseGroupId || (expectedGroupId && leaseGroupId !== expectedGroupId)) return;
    shareGroupIdRef.current = null;
    try {
      await window.larp.releaseScreenShare(leaseGroupId);
    } catch {
      if (currentMediaContextRef.current.groupId === leaseGroupId) {
        setShareError('Não foi possível finalizar o compartilhamento agora. A liberação será automática.');
      }
    }
  }, []);

  const stopScreenShare = useCallback(async () => {
    const session = sessionRef.current;
    const leaseGroupId = shareGroupIdRef.current;
    const currentMesh = currentMediaContextRef.current.mesh;
    signalMediaStateToPeers([...new Set([
      ...screenSignaledPeersRef.current,
      ...(currentMesh?.connectedPeerIds ?? []),
    ])], 'screen', false);
    shareOperationIdRef.current += 1;
    displayStreamRef.current = null;
    setDisplayStream(null);
    setShareActive(false);
    setShareSourceName('');
    await session?.stopDisplayShare();
    if (session && !isCurrentSession(session)) return;
    await releaseShareLease(leaseGroupId ?? undefined);
  }, [releaseShareLease, isCurrentSession, signalMediaStateToPeers]);

  useEffect(() => {
    if (!groupId || !mesh) {
      callActiveRef.current = false;
      setMediaReady(false);
      setAudioBusy(false);
      setNoiseSuppressionSupported(false);
      setCallActive(false);
      setMicMuted(false);
      for (const track of microphoneStreamRef.current?.getAudioTracks() ?? []) voiceActivityRef.current?.removeTrack(track);
      setSpeakingParticipantIds([]);
      microphoneStreamRef.current = null;
      displayStreamRef.current = null;
      clearRemoteAudioChannels();
      setDisplayStream(null);
      setShareActive(false);
      setShareSourceName('');
      setShareStarting(false);
      shareStartingRef.current = false;
      setRemoteVideoStream(null);
      remoteVideoStreamRef.current = null;
      return;
    }

    const session = new MediaSession({
      mesh,
      displaySourceProvider: {
        listSources: () => window.larp.listDisplaySources(),
        capture: async (source, options) => {
          if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('O compartilhamento de tela não está disponível neste computador.');
          await window.larp.prepareDisplayCapture(source.id, options.audio);
          return navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60, max: 60 } },
            audio: options.audio,
          });
        },
      },
      onDeviceRemoved: () => undefined,
      onDisplayEnded: () => {
        if (!isCurrentSession(session)) return;
        signalMediaStateToPeers([...new Set([
          ...screenSignaledPeersRef.current,
          ...mesh.connectedPeerIds,
        ])], 'screen', false);
        displayStreamRef.current = null;
        setDisplayStream(null);
        setShareActive(false);
        setShareSourceName('');
        void releaseShareLease(groupId);
      },
    });
    sessionOwnerRef.current = { session, groupId, mesh };
    sessionRef.current = session;
    setNoiseSuppressionSupported(supportsNoiseSuppression());
    if (transmissionAudioElementRef.current) session.attachTransmissionOutput(transmissionAudioElementRef.current);
    session.setVoicePlaybackVolume(voicePlaybackVolume);
    session.setTransmissionPlaybackVolume(transmissionPlaybackVolume);
    session.setPlaybackMuted(playbackMuted);
    setMediaReady(true);
    setAudioError('');
    const removeDeviceListener = session.onDeviceRemovedEvent(({ kind }) => {
      if (!isCurrentSession(session)) return;
      setAudioError(kind === 'audioinput'
        ? 'O microfone foi desconectado. A chamada foi interrompida.'
        : 'A saída de áudio selecionada foi removida. O áudio usará a saída padrão.');
      if (kind === 'audioinput') {
        const microphone = microphoneStreamRef.current;
        for (const track of microphone?.getAudioTracks() ?? []) track.enabled = false;
        microphoneStreamRef.current = null;
        callActiveRef.current = false;
        signalMediaStateToPeers([...new Set([
          ...voiceSignaledPeersRef.current,
          ...mesh.connectedPeerIds,
        ])], 'voice', false);
        session.setMicrophoneMuted(true);
        session.setVoicePlaybackMuted(true);
        setCallActive(false);
        setMicMuted(false);
      } else {
        setSelectedOutputId('');
      }
    });

    return () => {
      if (microphoneTestTimerRef.current) clearTimeout(microphoneTestTimerRef.current);
      microphoneTestTimerRef.current = undefined;
      void session.stopMicrophoneTest();
      for (const track of microphoneStreamRef.current?.getAudioTracks() ?? []) track.enabled = false;
      callActiveRef.current = false;
      for (const peerId of new Set([...voiceSignaledPeersRef.current, ...mesh.connectedPeerIds])) {
        void mesh.sendMediaState(peerId, 'voice', false).catch(() => undefined);
      }
      for (const peerId of new Set([...screenSignaledPeersRef.current, ...mesh.connectedPeerIds])) {
        void mesh.sendMediaState(peerId, 'screen', false).catch(() => undefined);
      }
      session.setVoicePlaybackMuted(true);
      removeDeviceListener();
      if (sessionOwnerRef.current?.session === session) {
        sessionOwnerRef.current = null;
        if (sessionRef.current === session) sessionRef.current = null;
        callOperationIdRef.current += 1;
        shareOperationIdRef.current += 1;
        shareStartingRef.current = false;
        setShareStarting(false);
      }
      void session.close();
      const leaseGroupId = shareGroupIdRef.current;
      if (leaseGroupId) void releaseShareLease(leaseGroupId);
      for (const track of microphoneStreamRef.current?.getAudioTracks() ?? []) voiceActivityRef.current?.removeTrack(track);
      microphoneStreamRef.current = null;
      displayStreamRef.current = null;
      clearRemoteAudioChannels();
      remoteVideoStreamRef.current = null;
      setMediaReady(false);
      setCallActive(false);
      setAudioBusy(false);
      setMicrophoneTestActive(false);
      setMicrophoneLevel(0);
      setShareActive(false);
      setShareSourceName('');
      setDisplayStream(null);
      setRemoteVideoStream(null);
    };
  }, [groupId, mesh, releaseShareLease, clearRemoteAudioChannels, isCurrentSession, signalMediaStateToPeers]);

  useEffect(() => {
    sessionRef.current?.setMicrophoneMuted(micMuted);
    sessionRef.current?.setPlaybackMuted(playbackMuted);
  }, [micMuted, playbackMuted]);

  useEffect(() => {
    if (!mediaReady || !transmissionAudioElementRef.current || !sessionRef.current) return;
    const session = sessionRef.current;
    session.attachTransmissionOutput(transmissionAudioElementRef.current);
    session.setPlaybackMuted(playbackMuted);
    session.setVoicePlaybackMuted(!callActive);
    session.setVoicePlaybackVolume(voicePlaybackVolume);
    for (const [peerId, volume] of Object.entries(voiceParticipantVolumes)) {
      session.setVoiceParticipantVolume(peerId, volume);
    }
    session.setTransmissionPlaybackVolume(transmissionPlaybackVolume);
    if (selectedOutputId) {
      void session.selectAudioOutput(selectedOutputId).then((state) => {
        if (state === 'available') return;
        setSelectedOutputId('');
        setAudioError('A saída selecionada não está mais disponível; o áudio usará a saída padrão.');
      });
    }
    refreshRemoteAudioOutputs();
  }, [mediaReady, callActive, playbackMuted, selectedOutputId, voicePlaybackVolume, voiceParticipantVolumes, transmissionPlaybackVolume, refreshRemoteAudioOutputs]);

  const refreshRemoteAudioPeerIds = useCallback(() => {
    const next = [...remoteAudioParticipantsRef.current.peerIds];
    setRemoteAudioPeerIds((current) => current.length === next.length && current.every((peerId, index) => peerId === next[index])
      ? current
      : next);
  }, []);

  const applyRemoteAudioSourceChange = useCallback((change: RemoteAudioSourceChange, added = false) => {
    const { record, previousSource, source } = change;
    const removeFromOutput = (outputSource: 'voice' | 'transmission') => {
      if (outputSource === 'voice') {
        const outputStream = remoteVoiceAudioStreamsByPeerRef.current.get(record.peerId);
        outputStream?.removeTrack(record.track);
        if (!outputStream || outputStream.getAudioTracks().length === 0) {
          remoteVoiceAudioStreamsByPeerRef.current.delete(record.peerId);
          sessionRef.current?.removeVoiceOutput(record.peerId);
        }
      } else {
        const outputStream = remoteTransmissionAudioStreamRef.current;
        outputStream?.removeTrack(record.track);
        if (outputStream && outputStream.getAudioTracks().length === 0) remoteTransmissionAudioStreamRef.current = null;
      }
    };
    if (previousSource !== source) {
      removeFromOutput(previousSource);
      if (previousSource === 'voice') voiceActivityRef.current?.removeTrack(record.track);
    }
    const state = remoteMediaStateRef.current.get(record.peerId);
    const sourceActive = source === 'voice' ? state?.voice !== false : state?.screen !== false;
    if (source === 'voice' && (previousSource !== 'voice' || added)) {
      if (sourceActive) voiceActivityRef.current?.addTrack(record.peerId, record.track);
    }
    if (change.peerJoined || change.peerLeft) refreshRemoteAudioPeerIds();
    if (sourceActive) {
      if (source === 'voice') {
        let outputStream = remoteVoiceAudioStreamsByPeerRef.current.get(record.peerId);
        if (!outputStream) {
          outputStream = new MediaStream();
          remoteVoiceAudioStreamsByPeerRef.current.set(record.peerId, outputStream);
        }
        if (!outputStream.getAudioTracks().includes(record.track)) outputStream.addTrack(record.track);
      } else {
        const outputStream = remoteTransmissionAudioStreamRef.current ?? new MediaStream();
        remoteTransmissionAudioStreamRef.current = outputStream;
        if (!outputStream.getAudioTracks().includes(record.track)) outputStream.addTrack(record.track);
      }
    }
    refreshRemoteAudioOutputs();
  }, [refreshRemoteAudioOutputs, refreshRemoteAudioPeerIds]);

  const removeRemoteAudioRecords = useCallback((records: readonly { peerId: string; track: MediaStreamTrack; source: 'voice' | 'transmission' }[]) => {
    for (const record of records) {
      if (record.source === 'voice') {
        const outputStream = remoteVoiceAudioStreamsByPeerRef.current.get(record.peerId);
        outputStream?.removeTrack(record.track);
        if (!outputStream || outputStream.getAudioTracks().length === 0) {
          remoteVoiceAudioStreamsByPeerRef.current.delete(record.peerId);
          sessionRef.current?.removeVoiceOutput(record.peerId);
        }
        voiceActivityRef.current?.removeTrack(record.track);
      } else {
        const outputStream = remoteTransmissionAudioStreamRef.current;
        outputStream?.removeTrack(record.track);
        if (outputStream && outputStream.getAudioTracks().length === 0) remoteTransmissionAudioStreamRef.current = null;
      }
    }
    refreshRemoteAudioOutputs();
  }, [refreshRemoteAudioOutputs]);

  const removeRemoteAudioTrack = useCallback((peerId: string, track: MediaStreamTrack) => {
    const { record, peerLeft } = remoteAudioParticipantsRef.current.removeTrack(peerId, track);
    if (!record) return;
    removeRemoteAudioRecords([record]);
    if (peerLeft) refreshRemoteAudioPeerIds();
  }, [removeRemoteAudioRecords, refreshRemoteAudioPeerIds]);

  const handleRemotePeerState = useCallback((peerId: string, state: PeerConnectionStatus) => {
    if (state !== 'closed') {
      remoteAudioParticipantsRef.current.setPeerState(peerId, state);
      setRemotePeerStates((current) => current[peerId] === state ? current : { ...current, [peerId]: state });
      refreshRemoteAudioPeerIds();
      return;
    }

    removeRemoteAudioRecords(remoteAudioParticipantsRef.current.removePeer(peerId));
    remoteMediaStateRef.current.delete(peerId);
    inactiveScreenStreamIdsRef.current.delete(peerId);
    voiceSignaledPeersRef.current.delete(peerId);
    screenSignaledPeersRef.current.delete(peerId);
    const videoStream = remoteVideoStreamsByPeerRef.current.get(peerId);
    remoteVideoStreamsByPeerRef.current.delete(peerId);
    if (videoStream && remoteVideoStreamRef.current === videoStream) {
      remoteVideoStreamRef.current = [...remoteVideoStreamsByPeerRef.current.values()].at(-1) ?? null;
      setRemoteVideoStream(remoteVideoStreamRef.current);
    }
    setRemotePeerStates((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    refreshRemoteAudioPeerIds();
  }, [removeRemoteAudioRecords, refreshRemoteAudioPeerIds]);

  const onRemoteTrack = useCallback((peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => {
    if (track.kind === 'audio') {
      if (track.readyState !== 'live') return;
      const inactiveScreenIds = inactiveScreenStreamIdsRef.current.get(peerId);
      if (remoteMediaStateRef.current.get(peerId)?.screen === false
        && streams.some((stream) => inactiveScreenIds?.has(stream.id))) return;
      const { record, added } = remoteAudioParticipantsRef.current.addAudioTrack(peerId, track, streams);
      const source = remoteAudioParticipantsRef.current.isTransmission(record) ? 'transmission' : 'voice';
      applyRemoteAudioSourceChange(remoteAudioParticipantsRef.current.setSource(record, source), added);
      if (added) track.addEventListener('ended', () => removeRemoteAudioTrack(peerId, track), { once: true });
      return;
    }
    if (track.kind !== 'video' || track.readyState !== 'live') return;
    const inactiveIds = inactiveScreenStreamIdsRef.current.get(peerId);
    if (remoteMediaStateRef.current.get(peerId)?.screen === false
      && streams.length > 0
      && streams.every((stream) => inactiveIds?.has(stream.id))) return;
    remoteMediaStateRef.current.set(peerId, {
      ...remoteMediaStateRef.current.get(peerId),
      screen: true,
    });
    inactiveScreenStreamIdsRef.current.delete(peerId);
    for (const change of remoteAudioParticipantsRef.current.addVideoStreams(peerId, streams)) {
      applyRemoteAudioSourceChange(change);
    }
    const stream = new MediaStream([track]);
    remoteVideoStreamsByPeerRef.current.set(peerId, stream);
    remoteVideoStreamRef.current = stream;
    setRemoteVideoStream(stream);
    track.addEventListener('ended', () => {
      stream.removeTrack(track);
      if (remoteVideoStreamsByPeerRef.current.get(peerId) !== stream) return;
      remoteVideoStreamsByPeerRef.current.delete(peerId);
      inactiveScreenStreamIdsRef.current.set(peerId, new Set(remoteAudioParticipantsRef.current.videoStreamIds(peerId)));
      remoteAudioParticipantsRef.current.clearVideoStreams(peerId);
      removeRemoteAudioRecords(remoteAudioParticipantsRef.current.removeSource(peerId, 'transmission').records);
      remoteVideoStreamRef.current = [...remoteVideoStreamsByPeerRef.current.values()].at(-1) ?? null;
      setRemoteVideoStream(remoteVideoStreamRef.current);
    }, { once: true });
  }, [applyRemoteAudioSourceChange, removeRemoteAudioRecords, removeRemoteAudioTrack]);


  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video) return;
    const stream = displayStream ?? remoteVideoStream;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => setShareError('A prévia de vídeo não pôde ser iniciada.'));
  }, [displayStream, remoteVideoStream]);

  const configureCodecPreference = useCallback(async (peerId: string, track: MediaStreamTrack) => {
    if (!mesh) return;
    const item = mesh.getMediaSenders().find((candidate) => candidate.peerId === peerId && candidate.sender.track === track);
    if (!item) return;
    const sender = item.sender;
    if (configuredSendersRef.current.has(sender)) return;
    configuredSendersRef.current.add(sender);
    const transceiver = item.connection.getTransceivers().find((candidate) => candidate.sender === sender);
    const controller = qualityControllerRef.current;
    try {
      const capabilities = RTCRtpSender.getCapabilities(track.kind as 'audio' | 'video');
      const mimes = capabilities?.codecs.map((codec) => codec.mimeType) ?? [];
      if (transceiver && track.kind === 'video') controller.setCompatibleVideoCodecs(transceiver, mimes);
      if (transceiver && track.kind === 'audio') controller.setCompatibleAudioCodecs(transceiver, mimes);
    } catch {
      // Codec preference is optional; WebRTC still negotiates its compatible default list.
    }
    if (track.kind === 'audio') {
      try {
        await controller.configureAudioSender(sender);
      } catch {
        // Keep the browser's default congestion-controlled audio parameters.
      }
    }
  }, [mesh]);

  const attachStreamToPeer = useCallback(async (
    peerId: string,
    stream: MediaStream,
    session = sessionRef.current,
    isOperationCurrent?: () => boolean,
  ) => {
    const isCurrent = () => Boolean(session && isCurrentSession(session) && isOperationCurrent?.() !== false);
    if (!session || !isCurrent()) return false;
    for (const track of stream.getTracks()) {
      if (!isCurrent()) return false;
      if (track.readyState !== 'live') continue;
      try {
        await session.attachTrack(peerId, track, stream);
      } catch (error) {
        try {
          await session.detachTrack(peerId, track);
        } catch {
          // The operation caller still performs full rollback for its stream.
        }
        throw error;
      }
      if (!isCurrent()) {
        await session.detachTrack(peerId, track);
        return false;
      }
      await configureCodecPreference(peerId, track);
      if (!isCurrent()) {
        await session.detachTrack(peerId, track);
        return false;
      }
    }
    return isCurrent();
  }, [configureCodecPreference, isCurrentSession]);
  const handleRemoteMediaState = useCallback((peerId: string, media: 'voice' | 'screen', active: boolean) => {
    const state = { ...remoteMediaStateRef.current.get(peerId), [media]: active };
    remoteMediaStateRef.current.set(peerId, state);
    if (media === 'voice') {
      const result = remoteAudioParticipantsRef.current.setVoiceActive(peerId, active);
      if (active) {
        for (const record of result.records) {
          applyRemoteAudioSourceChange(remoteAudioParticipantsRef.current.setSource(record, 'voice'), true);
        }
      } else {
        removeRemoteAudioRecords(result.records);
      }
      if (result.peerJoined || result.peerLeft) refreshRemoteAudioPeerIds();
      return;
    }

    if (!active) {
      inactiveScreenStreamIdsRef.current.set(peerId, new Set(remoteAudioParticipantsRef.current.videoStreamIds(peerId)));
      removeRemoteAudioRecords(remoteAudioParticipantsRef.current.removeSource(peerId, 'transmission').records);
      remoteAudioParticipantsRef.current.clearVideoStreams(peerId);
      const videoStream = remoteVideoStreamsByPeerRef.current.get(peerId);
      remoteVideoStreamsByPeerRef.current.delete(peerId);
      for (const track of videoStream?.getVideoTracks() ?? []) videoStream?.removeTrack(track);
      if (remoteVideoStreamRef.current === videoStream) {
        remoteVideoStreamRef.current = [...remoteVideoStreamsByPeerRef.current.values()].at(-1) ?? null;
        setRemoteVideoStream(remoteVideoStreamRef.current);
      }
      return;
    }

    inactiveScreenStreamIdsRef.current.delete(peerId);
    for (const record of remoteAudioParticipantsRef.current.records) {
      if (record.peerId === peerId && record.source === 'transmission') {
        applyRemoteAudioSourceChange(remoteAudioParticipantsRef.current.setSource(record, 'transmission'), true);
      }
    }
  }, [applyRemoteAudioSourceChange, refreshRemoteAudioPeerIds, removeRemoteAudioRecords]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !mesh) return;
    let current = true;
    for (const peerId of connectedPeerIds) {
      const microphone = callActive ? microphoneStreamRef.current : null;
      if (microphone) {
        void attachStreamToPeer(peerId, microphone).then((attached) => {
          if (current && attached) signalMediaState(peerId, 'voice', true);
        }).catch(() => {
          if (current) setAudioError('Não foi possível compartilhar o áudio com o participante.');
        });
      }
      const display = shareActive ? displayStreamRef.current : null;
      if (display) {
        void attachStreamToPeer(peerId, display).then((attached) => {
          if (current && attached) signalMediaState(peerId, 'screen', true);
        }).catch(() => {
          if (current) setAudioError('Não foi possível compartilhar o áudio com o participante.');
        });
      }
    }
    return () => { current = false; };
  }, [mesh, connectedPeerIds, callActive, shareActive, attachStreamToPeer, signalMediaState, mediaReady]);





  useEffect(() => {
    const controller = new MediaQualityController({
      totalVideoBitrate: Math.round(videoBudgetMbps * 1_000_000),
      maxVideoBitratePerPeer: 8_000_000,
      maxFrameRate: 60,
    });
    qualityControllerRef.current = controller;
  }, [videoBudgetMbps]);

  useEffect(() => {
    if (!shareActive || !mesh) return;
    let current = true;
    let busy = false;
    const controller = qualityControllerRef.current;
    const updateStats = async () => {
      if (busy || !current) return;
      busy = true;
      try {
        const videoPeers = mesh.getMediaSenders().filter((item) => item.sender.track?.kind === 'video');
        const mediaStats = await Promise.all(videoPeers.map((item) => controller.getPeerStats({
          peerId: item.peerId,
          sender: item.sender,
          peerConnection: item.connection,
          content: screenMode,
        })));
        const qualityPeers = await Promise.all(videoPeers.map(async (item, index) => {
          let availableOutgoingBitrate: number | undefined;
          try {
            const reports = await item.connection.getStats();
            const pair = [...reports.values()].find((report) => report.type === 'candidate-pair'
              && (report as RTCIceCandidatePairStats).state === 'succeeded'
              && (report as RTCIceCandidatePairStats).nominated) as (RTCIceCandidatePairStats & { availableOutgoingBitrate?: number }) | undefined;
            if (pair && Number.isFinite(pair.availableOutgoingBitrate) && (pair.availableOutgoingBitrate ?? 0) > 0) {
              availableOutgoingBitrate = pair.availableOutgoingBitrate;
            }
          } catch { /* Network cap is unavailable; the controller applies its configured budget. */ }
          return {
            peerId: item.peerId,
            sender: item.sender,
            peerConnection: item.connection,
            content: screenMode,
            availableOutgoingBitrate,
            cpuPressure: mediaStats[index]?.qualityLimitation.value === 'cpu' ? 'high' as const : 'unknown' as const,
          };
        }));
        await controller.allocate(qualityPeers);
        
      } finally {
        busy = false;
      }
    };
    void updateStats();
    const timer = setInterval(() => { void updateStats(); }, 2_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [mesh, shareActive, screenMode, videoBudgetMbps]);

  useEffect(() => {
    if (!shareActive || !groupId) return;
    let current = true;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void window.larp.acquireScreenShare(groupId)
        .then(async (held) => {
          if (!current) return;
          if (!held) {
            setShareError('O compartilhamento de tela foi interrompido.');
            await stopScreenShare();
          }
        })
        .catch(async () => {
          if (!current) return;
          setShareError('Não foi possível manter o compartilhamento. A transmissão foi encerrada.');
          await stopScreenShare();
        })
        .finally(() => { renewing = false; });
    }, 15_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [shareActive, groupId, stopScreenShare]);

  useEffect(() => {
    if (!microphoneTestActive) return;
    const timer = setInterval(() => setMicrophoneLevel(sessionRef.current?.getMicrophoneLevel() ?? 0), 100);
    return () => clearInterval(timer);
  }, [microphoneTestActive]);

  const refreshAudioDevices = useCallback(async (requestPermission = false) => {
    const session = sessionRef.current;
    if (!session) {
      setAudioError('Conecte-se a um grupo antes de configurar dispositivos de chamada.');
      return;
    }
    setAudioBusy(true);
    setAudioError('');
    try {
      if (requestPermission) {
        const permission = await session.requestMicrophonePermission(noiseSuppressionEnabled);
        if (permission.state !== 'active') {
          setAudioError(permission.state === 'permission-denied'
            ? 'A permissão do microfone foi negada nas permissões do Windows ou do Larp.'
            : 'O microfone não está disponível neste computador.');
          return;
        }
      }
      const [inputs, outputs] = await Promise.all([session.enumerateDevices('audioinput'), session.enumerateDevices('audiooutput')]);
      if (inputs.state !== 'available') {
        setAudioError(inputs.state === 'permission-denied' ? 'A permissão do microfone foi negada.' : 'Não foi possível listar microfones.');
        return;
      }
      const devices = [...inputs.devices, ...(outputs.state === 'available' ? outputs.devices : [])];
      setAudioDevices(devices);
      setSelectedMicrophoneId((current) => inputs.devices.some((device) => device.deviceId === current) ? current : inputs.devices[0]?.deviceId ?? '');
      setSelectedOutputId((current) => outputs.devices.some((device) => device.deviceId === current) ? current : outputs.devices[0]?.deviceId ?? '');
      if (inputs.devices.length === 0) setAudioError('Nenhum microfone disponível. Conecte um dispositivo e atualize a lista.');
    } catch {
      setAudioError('Não foi possível listar os dispositivos de áudio.');
    } finally {
      setAudioBusy(false);
    }
  }, [noiseSuppressionEnabled]);

  const selectMicrophone = useCallback((deviceId: string) => {
    if (callActive) {
      setAudioError('Saia da chamada antes de trocar o microfone.');
      return;
    }
    setSelectedMicrophoneId(deviceId);
  }, [callActive]);

  const selectAudioOutput = useCallback(async (deviceId: string) => {
    const session = sessionRef.current;
    if (!session) return;
    setAudioBusy(true);
    const state = await session.selectAudioOutput(deviceId);
    setAudioBusy(false);
    if (state === 'available') {
      setSelectedOutputId(deviceId);
      setAudioError('');
    } else {
      setAudioError(state === 'permission-denied' ? 'A permissão para selecionar esta saída foi negada.' : 'Não foi possível selecionar essa saída de áudio.');
    }
  }, []);

  const testOutput = useCallback(async () => {
    const played = await sessionRef.current?.playSafeTone();
    if (!played) setAudioError('Não foi possível reproduzir o tom de teste nesta saída.');
    else setAudioError('');
  }, []);

  const stopMicrophoneTest = useCallback(async () => {
    if (microphoneTestTimerRef.current) clearTimeout(microphoneTestTimerRef.current);
    microphoneTestTimerRef.current = undefined;
    setMicrophoneTestActive(false);
    setMicrophoneLevel(0);
    await sessionRef.current?.stopMicrophoneTest();
    if (!callActiveRef.current) {
      await sessionRef.current?.stopMicrophone();
      microphoneStreamRef.current = null;
    }
  }, []);

  const testMicrophone = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !selectedMicrophoneId) {
      setAudioError('Selecione e autorize um microfone antes de iniciar o teste.');
      return;
    }
    if (microphoneTestActive) {
      await stopMicrophoneTest();
      return;
    }
    setAudioBusy(true);
    setAudioError('');
    try {
      if (!microphoneStreamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) {
        const capture = await session.selectMicrophone(selectedMicrophoneId, noiseSuppressionEnabled);
        if (capture.state !== 'active' || !capture.stream) {
          setAudioError(capture.state === 'permission-denied'
            ? 'A permissão do microfone foi negada nas permissões do Windows ou do Larp.'
            : capture.state === 'unsupported'
              ? 'O microfone não está disponível neste computador.'
              : 'Não foi possível iniciar o microfone.');
          return;
        }
        microphoneStreamRef.current = capture.stream;
      }
      if (!await session.startMicrophoneTest()) {
        setAudioError('Não foi possível testar o microfone.');
        return;
      }
      setMicrophoneTestActive(true);
      microphoneTestTimerRef.current = setTimeout(() => { void stopMicrophoneTest(); }, 5_000);
    } catch {
      setAudioError('Não foi possível testar o microfone.');
    } finally {
      setAudioBusy(false);
    }
  }, [selectedMicrophoneId, microphoneTestActive, stopMicrophoneTest, noiseSuppressionEnabled]);

  const startCall = useCallback(async () => {
    if (!groupId || !mesh) {
      setAudioError('Conecte-se a um grupo antes de entrar na chamada.');
      return false;
    }
    const session = sessionRef.current;
    if (!session || !selectedMicrophoneId) {
      setAudioError('Selecione um microfone antes de entrar na chamada.');
      return false;
    }
    if (audioBusy || !isCurrentSession(session)) return false;

    const operationId = ++callOperationIdRef.current;
    const isOperationCurrent = () => operationId === callOperationIdRef.current && isCurrentSession(session);
    const voiceActivity = voiceActivityRef.current;
    const attachedPeerIds = new Set<string>();
    const voiceActivityTracks: MediaStreamTrack[] = [];
    let stream = microphoneStreamRef.current;
    let createdStream = false;
    const rollback = async () => {
      for (const peerId of attachedPeerIds) {
        for (const track of stream?.getTracks() ?? []) {
          try {
            await session.detachTrack(peerId, track);
          } catch {
            // Continue rolling back the remaining peer tracks.
          }
        }
      }
      for (const track of voiceActivityTracks) voiceActivity?.removeTrack(track);
      if (createdStream) {
        if (microphoneStreamRef.current === stream) microphoneStreamRef.current = null;
        await session.stopMicrophone();
      }
    };

    setAudioBusy(true);
    setAudioError('');
    try {
      if (!stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        const capture = await session.selectMicrophone(selectedMicrophoneId, noiseSuppressionEnabled);
        if (!isOperationCurrent()) {
          await session.stopMicrophone();
          return false;
        }
        if (capture.state !== 'active' || !capture.stream) {
          setAudioError(capture.state === 'permission-denied'
            ? 'A permissão do microfone foi negada nas permissões do Windows ou do Larp.'
            : capture.state === 'unsupported'
              ? 'O microfone não está disponível neste computador.'
              : 'Não foi possível iniciar o microfone.');
          return false;
        }
        stream = capture.stream;
        microphoneStreamRef.current = stream;
        createdStream = true;
      }
      if (!stream || !isOperationCurrent()) {
        await rollback();
        return false;
      }
      session.setMicrophoneMuted(micMuted);
      session.setVoicePlaybackMuted(false);
      if (localParticipantId) {
        for (const track of stream.getAudioTracks()) {
          voiceActivity?.addTrack(localParticipantId, track);
          voiceActivityTracks.push(track);
        }
      }
      for (const peerId of connectedPeerIds) {
        if (!isOperationCurrent()) {
          await rollback();
          return false;
        }
        attachedPeerIds.add(peerId);
        if (!await attachStreamToPeer(peerId, stream, session, isOperationCurrent)) {
          await rollback();
          return false;
        }
        signalMediaState(peerId, 'voice', true);
      }
      if (!isOperationCurrent()) {
        await rollback();
        return false;
      }
      callActiveRef.current = true;
      setCallActive(true);
      return true;
    } catch {
      await rollback();
      if (isOperationCurrent()) setAudioError('Não foi possível entrar na chamada.');
      return false;
    } finally {
      if (isOperationCurrent()) setAudioBusy(false);
    }
  }, [groupId, mesh, connectedPeerIds, selectedMicrophoneId, micMuted, attachStreamToPeer, signalMediaState, noiseSuppressionEnabled, localParticipantId, audioBusy, isCurrentSession]);

  const stopCall = useCallback(async () => {
    const session = sessionRef.current;
    const stream = microphoneStreamRef.current;
    const voiceActivity = voiceActivityRef.current;
    const currentMesh = currentMediaContextRef.current.mesh;
    callOperationIdRef.current += 1;
    callActiveRef.current = false;
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = false;
    session?.setMicrophoneMuted(true);
    session?.setVoicePlaybackMuted(true);
    signalMediaStateToPeers([...new Set([
      ...voiceSignaledPeersRef.current,
      ...(currentMesh?.connectedPeerIds ?? []),
    ])], 'voice', false);
    setAudioBusy(false);
    setCallActive(false);
    await session?.stopMicrophone();
    for (const track of stream?.getAudioTracks() ?? []) voiceActivity?.removeTrack(track);
    if (microphoneStreamRef.current === stream) microphoneStreamRef.current = null;
    setMicMuted(false);
  }, [signalMediaStateToPeers]);

  const toggleMicrophoneMuted = useCallback(() => {
    if (!callActive) return;
    setMicMuted((muted) => {
      sessionRef.current?.setMicrophoneMuted(!muted);
      return !muted;
    });
  }, [callActive]);

  const togglePlaybackMuted = useCallback(() => {
    setPlaybackMuted((muted) => {
      sessionRef.current?.setPlaybackMuted(!muted);
      return !muted;
    });
  }, []);
  const setVoicePlaybackVolume = useCallback((volume: number) => {
    if (!Number.isFinite(volume)) return;
    const normalized = normalizePlaybackVolume(volume);
    setVoicePlaybackVolumeState(normalized);
    sessionRef.current?.setVoicePlaybackVolume(normalized);
    try {
      saveVoicePlaybackVolume(window.localStorage, normalized);
    } catch {
      // The volume still applies until this window closes.
    }
  }, []);
  const setVoiceParticipantVolume = useCallback((userId: string, volume: number) => {
    if (!userId || !Number.isFinite(volume)) return;
    const normalized = normalizePlaybackVolume(volume);
    const next = { ...voiceParticipantVolumesRef.current, [userId]: normalized };
    voiceParticipantVolumesRef.current = next;
    setVoiceParticipantVolumesState(next);
    sessionRef.current?.setVoiceParticipantVolume(userId, normalized);
    try {
      saveVoiceParticipantVolumes(window.localStorage, next);
    } catch {
      // The volume still applies until this window closes.
    }
  }, []);
  const setTransmissionPlaybackVolume = useCallback((volume: number) => {
    if (!Number.isFinite(volume)) return;
    const normalized = normalizePlaybackVolume(volume);
    setTransmissionPlaybackVolumeState(normalized);
    sessionRef.current?.setTransmissionPlaybackVolume(normalized);
    try {
      saveTransmissionPlaybackVolume(window.localStorage, normalized);
    } catch {
      // The volume still applies until this window closes.
    }
  }, []);
  const setNoiseSuppression = useCallback((enabled: boolean) => {
    if (audioBusy || callActive || microphoneTestActive || enabled === noiseSuppressionEnabled) return;
    setNoiseSuppressionState(enabled);
    try {
      saveNoiseSuppression(window.localStorage, enabled);
    } catch {
      // The setting still applies until this window closes.
    }
    if (microphoneStreamRef.current) {
      microphoneStreamRef.current = null;
      void sessionRef.current?.stopMicrophone();
    }
  }, [audioBusy, callActive, microphoneTestActive, noiseSuppressionEnabled]);

  const refreshDisplaySources = useCallback(async () => {
    const result = await sessionRef.current?.listDisplaySources();
    if (!result || result.state !== 'available') {
      setShareError('Não foi possível listar as telas e janelas disponíveis.');
      setDisplaySources([]);
      return [];
    }
    setDisplaySources(result.sources);
    setSelectedDisplaySourceId((current) => result.sources.some((source) => source.id === current) ? current : '');
    setShareError('');
    return result.sources;
  }, []);

  const startScreenShare = useCallback(async (source: SelectedDisplaySource) => {
    if (shareStartingRef.current || shareActive) return false;
    const session = sessionRef.current;
    if (!groupId || !mesh || !session) {
      setShareError('A conexão com um grupo ativo é necessária para compartilhar a tela.');
      return false;
    }
    if (!isCurrentSession(session)) return false;

    const operationId = ++shareOperationIdRef.current;
    const isOperationCurrent = () => operationId === shareOperationIdRef.current && isCurrentSession(session);
    const attachedPeerIds = new Set<string>();
    let stream: MediaStream | undefined;
    let reservedLease = false;
    const releaseOperationLease = async () => {
      if (!reservedLease) return;
      reservedLease = false;
      if (shareGroupIdRef.current === groupId) {
        await releaseShareLease(groupId);
      } else {
        try {
          await window.larp.releaseScreenShare(groupId);
        } catch {
          // The old group owns this lease; do not surface it in a new group.
        }
      }
    };
    const rollback = async () => {
      if (stream) {
        for (const peerId of attachedPeerIds) {
          for (const track of stream.getTracks()) {
            try {
              await session.detachTrack(peerId, track);
            } catch {
              // Continue rolling back the remaining peer tracks.
            }
          }
        }
      }
      await session.stopDisplayShare();
      await releaseOperationLease();
    };

    shareStartingRef.current = true;
    setShareStarting(true);
    setShareError('');
    try {
      const reserved = await window.larp.acquireScreenShare(groupId);
      if (!isOperationCurrent()) {
        if (reserved) {
          try {
            await window.larp.releaseScreenShare(groupId);
          } catch {
            // The stale operation must not change the new group's UI.
          }
        }
        return false;
      }
      if (!reserved) {
        setShareError('Outra pessoa já está compartilhando a tela deste grupo.');
        return false;
      }
      reservedLease = true;
      shareGroupIdRef.current = groupId;

      const capture = await session.startDisplayShare(source, { audio: includeSystemAudio });
      stream = capture.stream;
      if (!isOperationCurrent()) {
        await rollback();
        return false;
      }
      if (capture.state !== 'active' || !stream) {
        setShareError(capture.state === 'permission-denied'
          ? 'A permissão para compartilhar a tela foi negada. Verifique as permissões deste computador.'
          : capture.state === 'unsupported'
            ? 'O compartilhamento de tela não está disponível neste computador.'
            : 'Não foi possível capturar a tela escolhida.');
        await rollback();
        return false;
      }
      for (const track of stream.getVideoTracks()) track.contentHint = screenMode === 'text' ? 'text' : 'motion';
      for (const peerId of mesh.connectedPeerIds) {
        if (!isOperationCurrent()) {
          await rollback();
          return false;
        }
        attachedPeerIds.add(peerId);
        if (!await attachStreamToPeer(peerId, stream, session, isOperationCurrent)) {
          await rollback();
          return false;
        }
        signalMediaState(peerId, 'screen', true);
      }
      if (!isOperationCurrent()) {
        await rollback();
        return false;
      }
      reservedLease = false;
      displayStreamRef.current = stream;
      setDisplayStream(stream);
      setShareSourceName(source.name);
      setShareActive(true);
      return true;
    } catch {
      await rollback();
      if (isOperationCurrent()) {
        setShareError('Não foi possível iniciar o compartilhamento. Verifique as permissões e tente novamente.');
      }
      return false;
    } finally {
      if (isOperationCurrent()) {
        shareStartingRef.current = false;
        setShareStarting(false);
      }
    }
  }, [groupId, mesh, includeSystemAudio, screenMode, attachStreamToPeer, signalMediaState, releaseShareLease, shareActive, isCurrentSession]);

  const setVideoBudgetMbps = useCallback((value: number) => {
    if (Number.isFinite(value)) setVideoBudgetMbpsState(Math.min(20, Math.max(1, value)));
  }, []);

  const handleRemoteTrack = useCallback((peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => {
    onRemoteTrack(peerId, track, streams);
  }, [onRemoteTrack]);

  const playCallJoinSound = useCallback(async () => {
    await sessionRef.current?.playSafeTone(880, 220);
  }, []);

  const playMessageNotificationSound = useCallback(async () => {
    await sessionRef.current?.playSafeTone(660, 120);
  }, []);

  return {
    mediaReady,
    audioDevices,
    audioInputs: audioDevices.filter((device) => device.kind === 'audioinput'),
    audioOutputs: audioDevices.filter((device) => device.kind === 'audiooutput'),
    selectedMicrophoneId,
    selectedOutputId,
    audioBusy,
    audioError,
    remoteAudioPeerIds,
    remotePeerStates,
    speakingParticipantIds,
    callActive,
    micMuted,
    playbackMuted,
    voicePlaybackVolume,
    setVoicePlaybackVolume,
    transmissionPlaybackVolume,
    setTransmissionPlaybackVolume,
    noiseSuppressionEnabled,
    noiseSuppressionSupported,
    setNoiseSuppression,
    microphoneTestActive,
    microphoneLevel,
    displaySources,
    selectedDisplaySourceId,
    setSelectedDisplaySourceId,
    includeSystemAudio,
    setIncludeSystemAudio,
    screenMode,
    setScreenMode,
    videoBudgetMbps,
    setVideoBudgetMbps,
    shareActive,
    shareSourceName,
    shareError,
    displayStream,
    shareStarting,
    remoteVideoStream,
    voiceParticipantVolumes,
    setVoiceParticipantVolume,
    transmissionAudioElementRef,
    screenVideoRef,
    handleRemoteTrack,
    handleRemotePeerState,
    handleRemoteMediaState,
    playCallJoinSound,
    playMessageNotificationSound,
    refreshAudioDevices,
    selectMicrophone,
    selectAudioOutput,
    testOutput,
    testMicrophone,
    stopMicrophoneTest,
    startCall,
    stopCall,
    toggleMicrophoneMuted,
    togglePlaybackMuted,
    refreshDisplaySources,
    startScreenShare,
    stopScreenShare,
  };
}
