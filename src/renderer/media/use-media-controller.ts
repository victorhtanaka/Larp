import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedDisplaySource } from '../../shared/contracts';
import { MediaQualityController, type PeerMediaStats, type VideoContentPreference } from './quality';
import { MediaSession, type MediaDeviceOption } from './session';
import type { PeerMesh } from '../rtc/peer-mesh';

interface MediaControllerOptions {
  groupId?: string;
  mesh: PeerMesh | null;
  connectedPeerIds: readonly string[];
}

export function useMediaController({ groupId, mesh, connectedPeerIds }: MediaControllerOptions) {
  const [mediaReady, setMediaReady] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState('');
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [callActive, setCallActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [playbackMuted, setPlaybackMuted] = useState(false);
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
  const [shareStats, setShareStats] = useState<PeerMediaStats[]>([]);
  const [shareStarting, setShareStarting] = useState(false);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);

  const sessionRef = useRef<MediaSession | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const shareGroupIdRef = useRef<string | null>(null);
  const microphoneTestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shareStartingRef = useRef(false);
  const callActiveRef = useRef(false);
  const configuredSendersRef = useRef(new WeakSet<RTCRtpSender>());
  const qualityControllerRef = useRef(new MediaQualityController());

  callActiveRef.current = callActive;

  const releaseShareLease = useCallback(async (expectedGroupId?: string) => {
    const leaseGroupId = shareGroupIdRef.current;
    if (!leaseGroupId || (expectedGroupId && leaseGroupId !== expectedGroupId)) return;
    shareGroupIdRef.current = null;
    try {
      await window.larp.releaseScreenShare(leaseGroupId);
    } catch {
      setShareError('A reserva da tela será liberada quando expirar; a conexão com a sinalização está indisponível.');
    }
  }, []);

  const stopScreenShare = useCallback(async () => {
    await sessionRef.current?.stopDisplayShare();
    displayStreamRef.current = null;
    setDisplayStream(null);
    setShareActive(false);
    setShareSourceName('');
    await releaseShareLease();
  }, [releaseShareLease]);

  useEffect(() => {
    if (!groupId || !mesh) {
      setMediaReady(false);
      setCallActive(false);
      setMicMuted(false);
      microphoneStreamRef.current = null;
      displayStreamRef.current = null;
      setDisplayStream(null);
      setShareActive(false);
      setShareSourceName('');
      setRemoteVideoStream(null);
      remoteVideoStreamRef.current = null;
      remoteAudioStreamRef.current = null;
      if (audioElementRef.current) audioElementRef.current.srcObject = null;
      return;
    }

    const session = new MediaSession({
      mesh,
      displaySourceProvider: {
        listSources: () => window.larp.listDisplaySources(),
        capture: async (source, options) => {
          if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Captura de tela não é suportada nesta versão do Electron.');
          await window.larp.prepareDisplayCapture(source.id, options.audio);
          return navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60, max: 60 } },
            audio: options.audio,
          });
        },
      },
      onDeviceRemoved: () => undefined,
      onDisplayEnded: () => {
        displayStreamRef.current = null;
        setDisplayStream(null);
        setShareActive(false);
        setShareSourceName('');
        void releaseShareLease(groupId);
      },
    });
    sessionRef.current = session;
    if (audioElementRef.current) session.attachOutput(audioElementRef.current);
    setMediaReady(true);
    setAudioError('');
    const removeDeviceListener = session.onDeviceRemovedEvent(({ kind, deviceId }) => {
      setAudioError(kind === 'audioinput'
        ? `O microfone ${deviceId.slice(0, 8)} foi desconectado. A chamada foi interrompida.`
        : 'A saída de áudio selecionada foi removida. O áudio usará a saída padrão.');
      if (kind === 'audioinput') {
        microphoneStreamRef.current = null;
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
      removeDeviceListener();
      if (sessionRef.current === session) sessionRef.current = null;
      void session.close();
      const leaseGroupId = shareGroupIdRef.current;
      if (leaseGroupId) void releaseShareLease(leaseGroupId);
      microphoneStreamRef.current = null;
      displayStreamRef.current = null;
      remoteAudioStreamRef.current = null;
      remoteVideoStreamRef.current = null;
      setMediaReady(false);
      setCallActive(false);
      setMicrophoneTestActive(false);
      setMicrophoneLevel(0);
      setShareActive(false);
      setShareSourceName('');
      setDisplayStream(null);
      setRemoteVideoStream(null);
    };
  }, [groupId, mesh, releaseShareLease]);

  useEffect(() => {
    sessionRef.current?.setMicrophoneMuted(micMuted);
    sessionRef.current?.setPlaybackMuted(playbackMuted);
  }, [micMuted, playbackMuted]);

  useEffect(() => {
    if (!mediaReady || !audioElementRef.current || !sessionRef.current) return;
    const session = sessionRef.current;
    session.attachOutput(audioElementRef.current);
    session.setPlaybackMuted(playbackMuted);
    if (selectedOutputId) {
      void session.selectAudioOutput(selectedOutputId, audioElementRef.current).then((state) => {
        if (state === 'available') return;
        setSelectedOutputId('');
        setAudioError('A saída selecionada não está mais disponível; o áudio usará a saída padrão.');
      });
    }
  }, [mediaReady, playbackMuted, selectedOutputId]);

  useEffect(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    const stream = remoteAudioStreamRef.current;
    audio.srcObject = stream;
    if (stream) void audio.play().catch(() => setAudioError('O áudio remoto está pronto. Clique em “Saída de áudio” para liberá-lo.'));
  }, [remoteVideoStream, mediaReady]);

  const onRemoteTrack = useCallback((track: MediaStreamTrack) => {
    if (track.kind === 'audio') {
      const stream = remoteAudioStreamRef.current ?? new MediaStream();
      remoteAudioStreamRef.current = stream;
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = stream;
        void audioElementRef.current.play().catch(() => setAudioError('O áudio remoto está pronto. Clique em “Saída de áudio” para liberá-lo.'));
      }
      track.addEventListener('ended', () => {
        stream.removeTrack(track);
        if (stream.getTracks().length === 0) remoteAudioStreamRef.current = null;
      }, { once: true });
      return;
    }
    if (track.kind !== 'video') return;
    const stream = new MediaStream([track]);
    remoteVideoStreamRef.current = stream;
    setRemoteVideoStream(stream);
    track.addEventListener('ended', () => {
      stream.removeTrack(track);
      if (remoteVideoStreamRef.current === stream) {
        remoteVideoStreamRef.current = null;
        setRemoteVideoStream(null);
      }
    }, { once: true });
  }, []);

  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video) return;
    const stream = displayStream ?? remoteVideoStream;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => setShareError('A prévia de vídeo não pôde ser iniciada.'));
  }, [displayStream, remoteVideoStream]);

  const configureCodecPreference = useCallback((peerId: string, track: MediaStreamTrack) => {
    if (!mesh) return;
    const item = mesh.getMediaSenders().find((candidate) => candidate.peerId === peerId && candidate.sender.track === track);
    if (!item) return;
    const sender = item.sender;
    if (configuredSendersRef.current.has(sender)) return;
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
    configuredSendersRef.current.add(sender);
  }, [mesh]);

  const attachStreamToPeer = useCallback(async (peerId: string, stream: MediaStream) => {
    const session = sessionRef.current;
    if (!session) return;
    for (const track of stream.getTracks()) {
      if (track.readyState !== 'live') continue;
      await session.attachTrack(peerId, track, stream);
      configureCodecPreference(peerId, track);
    }
  }, [configureCodecPreference]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !mesh) return;
    const streams = [callActive ? microphoneStreamRef.current : null, shareActive ? displayStreamRef.current : null]
      .filter((stream): stream is MediaStream => Boolean(stream));
    let current = true;
    for (const peerId of connectedPeerIds) {
      for (const stream of streams) {
        void attachStreamToPeer(peerId, stream).catch((cause: unknown) => {
          if (current) setAudioError(cause instanceof Error ? cause.message : 'Não foi possível adicionar a mídia ao participante.');
        });
      }
    }
    return () => { current = false; };
  }, [mesh, connectedPeerIds, callActive, shareActive, attachStreamToPeer, mediaReady]);

  useEffect(() => {
    const controller = new MediaQualityController({
      totalVideoBitrate: Math.round(videoBudgetMbps * 1_000_000),
      maxVideoBitratePerPeer: 8_000_000,
      maxFrameRate: 60,
    });
    qualityControllerRef.current = controller;
  }, [videoBudgetMbps]);

  useEffect(() => {
    if (!shareActive || !mesh) {
      setShareStats([]);
      return;
    }
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
        if (current) setShareStats(mediaStats);
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
            setShareError('A reserva da tela foi perdida para outro participante.');
            await stopScreenShare();
          }
        })
        .catch(async () => {
          if (!current) return;
          setShareError('Não foi possível renovar a reserva da tela. A transmissão foi encerrada.');
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
        const permission = await session.requestMicrophonePermission();
        if (permission.state !== 'active') {
          setAudioError(permission.state === 'permission-denied'
            ? 'A permissão do microfone foi negada nas permissões do Windows ou do Larp.'
            : permission.error ?? 'Nenhum microfone compatível foi encontrado.');
          return;
        }
      }
      const [inputs, outputs] = await Promise.all([session.enumerateDevices('audioinput'), session.enumerateDevices('audiooutput')]);
      if (inputs.state !== 'available') {
        setAudioError(inputs.state === 'permission-denied' ? 'Permissão do microfone negada.' : inputs.error ?? 'Não foi possível listar microfones.');
        return;
      }
      const devices = [...inputs.devices, ...(outputs.state === 'available' ? outputs.devices : [])];
      setAudioDevices(devices);
      setSelectedMicrophoneId((current) => inputs.devices.some((device) => device.deviceId === current) ? current : inputs.devices[0]?.deviceId ?? '');
      setSelectedOutputId((current) => outputs.devices.some((device) => device.deviceId === current) ? current : outputs.devices[0]?.deviceId ?? '');
      if (inputs.devices.length === 0) setAudioError('Nenhum microfone disponível. Conecte um dispositivo e atualize a lista.');
    } catch (cause) {
      setAudioError(cause instanceof Error ? cause.message : 'Não foi possível listar os dispositivos de áudio.');
    } finally {
      setAudioBusy(false);
    }
  }, []);

  const selectMicrophone = useCallback((deviceId: string) => {
    if (callActive) {
      setAudioError('Saia da chamada antes de trocar o microfone.');
      return;
    }
    setSelectedMicrophoneId(deviceId);
  }, [callActive]);

  const selectAudioOutput = useCallback(async (deviceId: string) => {
    const session = sessionRef.current;
    const element = audioElementRef.current;
    if (!session || !element) return;
    setAudioBusy(true);
    const state = await session.selectAudioOutput(deviceId, element);
    setAudioBusy(false);
    if (state === 'available') {
      setSelectedOutputId(deviceId);
      setAudioError('');
    } else {
      setAudioError(state === 'permission-denied' ? 'A seleção da saída foi negada pelo Windows.' : 'Esta versão do Electron não permite selecionar essa saída de áudio.');
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
        const capture = await session.selectMicrophone(selectedMicrophoneId);
        if (capture.state !== 'active' || !capture.stream) throw new Error(capture.error ?? 'Não foi possível iniciar o microfone.');
        microphoneStreamRef.current = capture.stream;
      }
      if (!await session.startMicrophoneTest()) throw new Error('O teste do microfone não pôde ser iniciado.');
      setMicrophoneTestActive(true);
      microphoneTestTimerRef.current = setTimeout(() => { void stopMicrophoneTest(); }, 5_000);
    } catch (cause) {
      setAudioError(cause instanceof Error ? cause.message : 'Não foi possível testar o microfone.');
    } finally {
      setAudioBusy(false);
    }
  }, [selectedMicrophoneId, microphoneTestActive, stopMicrophoneTest]);

  const startCall = useCallback(async () => {
    if (!groupId || !mesh || connectedPeerIds.length === 0) {
      setAudioError('Nenhum participante está conectado para receber a chamada.');
      return false;
    }
    const session = sessionRef.current;
    if (!session || !selectedMicrophoneId) {
      setAudioError('Selecione um microfone antes de entrar na chamada.');
      return false;
    }
    setAudioBusy(true);
    setAudioError('');
    try {
      let stream = microphoneStreamRef.current;
      if (!stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        const capture = await session.selectMicrophone(selectedMicrophoneId);
        if (capture.state !== 'active' || !capture.stream) throw new Error(capture.error ?? 'Não foi possível iniciar o microfone.');
        stream = capture.stream;
        microphoneStreamRef.current = stream;
      }
      session.setMicrophoneMuted(micMuted);
      for (const peerId of connectedPeerIds) await attachStreamToPeer(peerId, stream);
      setCallActive(true);
      return true;
    } catch (cause) {
      setAudioError(cause instanceof Error ? cause.message : 'Não foi possível entrar na chamada.');
      return false;
    } finally {
      setAudioBusy(false);
    }
  }, [groupId, mesh, connectedPeerIds, selectedMicrophoneId, micMuted, attachStreamToPeer]);

  const stopCall = useCallback(async () => {
    setCallActive(false);
    setMicMuted(false);
    sessionRef.current?.setMicrophoneMuted(false);
    await sessionRef.current?.stopMicrophone();
    microphoneStreamRef.current = null;
  }, []);

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

  const refreshDisplaySources = useCallback(async () => {
    const result = await sessionRef.current?.listDisplaySources();
    if (!result || result.state !== 'available') {
      setShareError(result?.error ?? 'A lista de telas e janelas não está disponível.');
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
    shareStartingRef.current = true;
    setShareStarting(true);
    setShareError('');
    try {
      const reserved = await window.larp.acquireScreenShare(groupId);
      if (!reserved) throw new Error('Outra pessoa já está compartilhando a tela deste grupo.');
      shareGroupIdRef.current = groupId;
      const capture = await session.startDisplayShare(source, { audio: includeSystemAudio });
      if (capture.state !== 'active' || !capture.stream) throw new Error(capture.error ?? 'Não foi possível capturar a fonte selecionada.');
      for (const track of capture.stream.getVideoTracks()) track.contentHint = screenMode === 'text' ? 'text' : 'motion';
      for (const peerId of mesh.connectedPeerIds) await attachStreamToPeer(peerId, capture.stream);
      displayStreamRef.current = capture.stream;
      setDisplayStream(capture.stream);
      setShareSourceName(source.name);
      setShareActive(true);
      return true;
    } catch (cause) {
      setShareError(cause instanceof Error ? cause.message : 'Não foi possível iniciar o compartilhamento.');
      await session.stopDisplayShare();
      await releaseShareLease(groupId);
      return false;
    } finally {
      shareStartingRef.current = false;
      setShareStarting(false);
    }
  }, [groupId, mesh, includeSystemAudio, screenMode, attachStreamToPeer, releaseShareLease, shareActive]);

  const setVideoBudgetMbps = useCallback((value: number) => {
    if (Number.isFinite(value)) setVideoBudgetMbpsState(Math.min(20, Math.max(1, value)));
  }, []);

  const handleRemoteTrack = useCallback((peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => {
    void peerId;
    void streams;
    onRemoteTrack(track);
  }, [onRemoteTrack]);

  return {
    mediaReady,
    audioDevices,
    audioInputs: audioDevices.filter((device) => device.kind === 'audioinput'),
    audioOutputs: audioDevices.filter((device) => device.kind === 'audiooutput'),
    selectedMicrophoneId,
    selectedOutputId,
    audioBusy,
    audioError,
    callActive,
    micMuted,
    playbackMuted,
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
    shareStats,
    displayStream,
    shareStarting,
    remoteVideoStream,
    audioElementRef,
    screenVideoRef,
    handleRemoteTrack,
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
