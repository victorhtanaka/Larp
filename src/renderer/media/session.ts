import type { SelectedDisplaySource } from '../../shared/contracts';
import { normalizePlaybackVolume } from './playback-volume';
export type MediaDeviceKind = 'audioinput' | 'audiooutput';

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId: string;
}

export type DeviceAccessState = 'available' | 'permission-denied' | 'unavailable';

export interface DeviceEnumeration {
  state: DeviceAccessState;
  devices: MediaDeviceOption[];
  error?: string;
}


/** Electron integrations must implement explicit source selection/acquisition. */
export interface DisplaySourceProvider {
  listSources(): Promise<SelectedDisplaySource[]>;
  capture(source: SelectedDisplaySource, options: { audio: boolean }): Promise<MediaStream>;
}

export interface MeshTrackSender {
  /** Attach to the peer's existing sender slot, or add a new transceiver track. */
  attachTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): Promise<void> | void;
  /** Detach a previously attached track; must be safe when already detached. */
  detachTrack(peerId: string, track: MediaStreamTrack): Promise<void> | void;
}

export interface MediaSessionOptions {
  mediaDevices?: MediaDevices;
  displaySourceProvider?: DisplaySourceProvider;
  mesh: MeshTrackSender;
  audioContextFactory?: () => AudioContext;
  audioElementFactory?: () => HTMLAudioElement;
  onDeviceRemoved?: (deviceId: string) => void;
  onDisplayEnded?: () => void;
}

export interface CaptureResult {
  state: 'active' | 'permission-denied' | 'device-unavailable' | 'unsupported';
  stream?: MediaStream;
  error?: string;
}

const microphoneConstraints = (deviceId?: string, noiseSuppression = true): MediaStreamConstraints => ({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression,
    autoGainControl: true,
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
  },
  video: false,
});

export function supportsNoiseSuppression(mediaDevices?: MediaDevices): boolean {
  try {
    const devices = mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    return devices?.getSupportedConstraints().noiseSuppression === true;
  } catch {
    return false;
  }
}


function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Media operation failed';
}

function unavailableDevices(): DeviceEnumeration {
  return { state: 'unavailable', devices: [] };
}

/** Owns capture tracks, output routing, and any Web Audio resources it creates. */
export class MediaSession {
  private readonly mediaDevices?: MediaDevices;
  private readonly displaySourceProvider?: DisplaySourceProvider;
  private readonly mesh: MeshTrackSender;
  private readonly audioContextFactory: () => AudioContext;
  private readonly audioElementFactory: () => HTMLAudioElement;
  private readonly onDeviceRemoved?: (deviceId: string) => void;
  private readonly onDisplayEnded?: () => void;
  private readonly ownedTracks = new Map<MediaStreamTrack, Set<string>>();
  private readonly streams = new Set<MediaStream>();
  private readonly deviceChangeHandler = () => this.handleDeviceChange();
  private selectedMicrophoneId?: string;
  private selectedOutputId?: string;
  private microphone?: MediaStream;
  private displayStream?: MediaStream;
  private readonly voiceOutputs = new Map<string, HTMLAudioElement>();
  private readonly voiceParticipantVolumes = new Map<string, number>();
  private transmissionOutput?: HTMLAudioElement;
  private microphoneTestContext?: AudioContext;
  private microphoneTestAnalyser?: AnalyserNode;
  private microphoneTestSource?: MediaStreamAudioSourceNode;
  private microphoneTestSamples?: Uint8Array<ArrayBuffer>;
  private toneContext?: AudioContext;
  private toneNodes: AudioScheduledSourceNode[] = [];
  private micMuted = false;
  private playbackMuted = false;
  private voiceMutedByCall = false;
  private voicePlaybackVolume = 1;
  private transmissionPlaybackVolume = 1;
  private closed = false;
  private readonly pageHideHandler = () => { void this.close(); };
  private readonly deviceListeners = new Set<(event: { kind: MediaDeviceKind; deviceId: string }) => void>();

  constructor(options: MediaSessionOptions) {
    this.mediaDevices = options.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.displaySourceProvider = options.displaySourceProvider;
    this.mesh = options.mesh;
    this.audioContextFactory = options.audioContextFactory ?? (() => new AudioContext());
    this.audioElementFactory = options.audioElementFactory ?? (() => new Audio());
    this.onDeviceRemoved = options.onDeviceRemoved;
    this.onDisplayEnded = options.onDisplayEnded;
    if (this.mediaDevices && typeof this.mediaDevices.addEventListener === 'function') {
      this.mediaDevices.addEventListener('devicechange', this.deviceChangeHandler);
    }
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.pageHideHandler);
  }

  async listDisplaySources(): Promise<{ state: 'available' | 'unsupported' | 'unavailable'; sources: SelectedDisplaySource[]; error?: string }> {
    if (this.closed || !this.displaySourceProvider || typeof this.displaySourceProvider.listSources !== 'function') {
      return { state: 'unsupported', sources: [] };
    }
    try {
      const sources = await this.displaySourceProvider.listSources();
      return { state: 'available', sources: sources.filter((source) => Boolean(source.id && source.name && (source.kind === 'screen' || source.kind === 'window'))) };
    } catch (error) {
      return { state: 'unavailable', sources: [], error: errorMessage(error) };
    }
  }

  async enumerateDevices(kind: MediaDeviceKind): Promise<DeviceEnumeration> {
    if (this.closed || !this.mediaDevices || typeof this.mediaDevices.enumerateDevices !== 'function') return unavailableDevices();
    try {
      const devices = await this.mediaDevices.enumerateDevices();
      return {
        state: 'available',
        devices: devices.filter((device) => device.kind === kind).map((device) => ({
          deviceId: device.deviceId,
          label: device.label || (device.deviceId ? `Device ${device.deviceId.slice(0, 8)}` : 'Default device'),
          kind,
          groupId: device.groupId,
        })),
      };
    } catch (error) {
      return { state: errorName(error) === 'NotAllowedError' ? 'permission-denied' : 'unavailable', devices: [], error: errorMessage(error) };
    }
  }

  async requestMicrophonePermission(noiseSuppression = true): Promise<CaptureResult> {
    if (this.closed || !this.mediaDevices || typeof this.mediaDevices.getUserMedia !== 'function') return { state: 'unsupported' };
    try {
      const temporaryStream = await this.mediaDevices.getUserMedia(microphoneConstraints(undefined, noiseSuppression));
      temporaryStream.getTracks().forEach((track) => track.stop());
      return { state: 'active' };
    } catch (error) {
      const name = errorName(error);
      return { state: name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'permission-denied' : 'device-unavailable', error: errorMessage(error) };
    }
  }

  async selectMicrophone(deviceId: string, noiseSuppression = true): Promise<CaptureResult> {
    if (!deviceId) return { state: 'device-unavailable', error: 'Select a microphone explicitly.' };
    if (this.closed || !this.mediaDevices || typeof this.mediaDevices.getUserMedia !== 'function') return { state: 'unsupported' };
    await this.stopMicrophone();
    try {
      const stream = await this.mediaDevices.getUserMedia(microphoneConstraints(deviceId, noiseSuppression));
      this.selectedMicrophoneId = deviceId;
      this.microphone = stream;
      this.ownStream(stream);
      for (const track of stream.getAudioTracks()) {
        track.enabled = !this.micMuted;
        track.addEventListener('ended', () => this.microphoneTrackEnded(deviceId, stream), { once: true });
      }
      return { state: 'active', stream };
    } catch (error) {
      this.selectedMicrophoneId = undefined;
      const name = errorName(error);
      return { state: name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'permission-denied' : 'device-unavailable', error: errorMessage(error) };
    }
  }

  async selectAudioOutput(deviceId: string): Promise<DeviceEnumeration['state']> {
    if (this.closed || !this.mediaDevices) return 'unavailable';
    const targets = this.outputElements();
    if (targets.length === 0 || targets.some((target) => typeof target.setSinkId !== 'function')) return 'unavailable';
    if (deviceId) {
      const listed = await this.enumerateDevices('audiooutput');
      if (listed.state !== 'available') return listed.state;
      if (!listed.devices.some((device) => device.deviceId === deviceId)) {
        this.selectedOutputId = undefined;
        return 'unavailable';
      }
    }
    const previousSinkId = this.selectedOutputId ?? '';
    try {
      await Promise.all(targets.map((target) => target.setSinkId(deviceId)));
      this.selectedOutputId = deviceId || undefined;
      return 'available';
    } catch (error) {
      await Promise.all(targets.map((target) => target.setSinkId(previousSinkId).catch(() => undefined)));
      return errorName(error) === 'NotAllowedError' ? 'permission-denied' : 'unavailable';
    }
  }

  attachTransmissionOutput(element: HTMLAudioElement): void {
    if (this.closed) return;
    this.transmissionOutput = element;
    element.muted = this.playbackMuted;
    element.volume = this.transmissionPlaybackVolume;
    this.applyOutputSink(element);
  }

  setVoiceOutput(userId: string, stream: MediaStream | null): Promise<void> {
    if (this.closed || !userId) return Promise.resolve();
    if (!stream) {
      const output = this.voiceOutputs.get(userId);
      if (output) {
        output.pause();
        output.srcObject = null;
      }
      return Promise.resolve();
    }
    let output = this.voiceOutputs.get(userId);
    if (!output) {
      output = this.audioElementFactory();
      output.autoplay = true;
      this.voiceOutputs.set(userId, output);
      this.applyOutputSink(output);
    }
    output.srcObject = stream;
    this.applyVoiceOutput(userId, output);
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) return Promise.resolve();
    return Promise.resolve().then(() => output.play()).then(() => undefined);
  }

  removeVoiceOutput(userId: string): void {
    const output = this.voiceOutputs.get(userId);
    if (!output) return;
    output.pause();
    output.srcObject = null;
    this.voiceOutputs.delete(userId);
  }

  private applyVoiceOutput(userId: string, output: HTMLAudioElement): void {
    const individualVolume = this.voiceParticipantVolumes.get(userId) ?? this.voicePlaybackVolume;
    output.muted = this.playbackMuted || this.voiceMutedByCall;
    output.volume = normalizePlaybackVolume(this.voicePlaybackVolume * individualVolume);
  }


  private applyOutputSink(output: HTMLAudioElement): void {
    if (this.selectedOutputId && typeof output.setSinkId === 'function') {
      void output.setSinkId(this.selectedOutputId).catch(() => { this.selectedOutputId = undefined; });
    }
  }

  private outputElements(): HTMLAudioElement[] {
    return [...this.voiceOutputs.values(), ...(this.transmissionOutput ? [this.transmissionOutput] : [])];
  }

  setPlaybackMuted(muted: boolean): void {
    this.playbackMuted = muted;
    for (const [userId, output] of this.voiceOutputs) this.applyVoiceOutput(userId, output);
    if (this.transmissionOutput) this.transmissionOutput.muted = muted;
  }

  setVoicePlaybackMuted(muted: boolean): void {
    this.voiceMutedByCall = muted;
    for (const [userId, output] of this.voiceOutputs) this.applyVoiceOutput(userId, output);
  }

  setVoicePlaybackVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.voicePlaybackVolume = normalizePlaybackVolume(volume);
    for (const [userId, output] of this.voiceOutputs) this.applyVoiceOutput(userId, output);
  }

  setVoiceParticipantVolume(userId: string, volume: number): void {
    if (!userId || !Number.isFinite(volume)) return;
    this.voiceParticipantVolumes.set(userId, normalizePlaybackVolume(volume));
    const output = this.voiceOutputs.get(userId);
    if (output) this.applyVoiceOutput(userId, output);
  }

  setTransmissionPlaybackVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.transmissionPlaybackVolume = normalizePlaybackVolume(volume);
    if (this.transmissionOutput) this.transmissionOutput.volume = this.transmissionPlaybackVolume;
  }

  setMicrophoneMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  }




  async startDisplayShare(source: SelectedDisplaySource | undefined, options: { audio?: boolean } = {}): Promise<CaptureResult> {
    if (this.closed || !this.displaySourceProvider) return { state: 'unsupported' };
    if (!source || !source.id || !source.name || (source.kind !== 'screen' && source.kind !== 'window')) {
      return { state: 'device-unavailable', error: 'An explicitly selected screen or window is required.' };
    }
    const available = await this.listDisplaySources();
    if (available.state !== 'available' || !available.sources.some((candidate) => candidate.id === source.id && candidate.kind === source.kind)) {
      return { state: 'device-unavailable', error: 'The selected display source is no longer available.' };
    }
    await this.stopDisplayShare();
    try {
      const stream = await this.displaySourceProvider.capture(source, { audio: options.audio === true });
      if (!stream || stream.getVideoTracks().length === 0) {
        stream?.getTracks().forEach((track) => track.stop());
        return { state: 'device-unavailable', error: 'The selected source returned no video track.' };
      }
      if (options.audio && stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        return { state: 'device-unavailable', error: 'A captura de áudio do sistema não está disponível nesta sessão.' };
      }
      this.displayStream = stream;
      this.ownStream(stream);
      for (const track of stream.getVideoTracks()) {
        if ('contentHint' in track) track.contentHint = 'detail';
        track.addEventListener('ended', this.displayEndedHandler, { once: true });
      }
      return { state: 'active', stream };
    } catch (error) {
      const name = errorName(error);
      return { state: name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'permission-denied' : 'device-unavailable', error: errorMessage(error) };
    }
  }

  async attachTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    if (this.closed) throw new Error('Media session is closed');
    if (!peerId || track.readyState !== 'live' || !stream.getTracks().includes(track)) throw new Error('A live session track and peer are required');
    await this.mesh.attachTrack(peerId, track, stream);
    const peers = this.ownedTracks.get(track) ?? new Set<string>();
    peers.add(peerId);
    this.ownedTracks.set(track, peers);
  }

  async detachTrack(peerId: string, track: MediaStreamTrack): Promise<void> {
    if (!this.ownedTracks.get(track)?.has(peerId)) return;
    try { await this.mesh.detachTrack(peerId, track); } finally {
      const peers = this.ownedTracks.get(track);
      peers?.delete(peerId);
      if (peers?.size === 0) this.ownedTracks.delete(track);
    }
  }

  onDeviceRemovedEvent(listener: (event: { kind: MediaDeviceKind; deviceId: string }) => void): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  async playSafeTone(frequency = 440, durationMs = 180): Promise<boolean> {
    if (this.closed || typeof AudioContext === 'undefined' || !Number.isFinite(frequency) || frequency < 100 || frequency > 2000 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 1000) return false;
    try {
      const context = this.toneContext ?? this.audioContextFactory();
      const sinkContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
      if (this.selectedOutputId && typeof sinkContext.setSinkId === 'function') await sinkContext.setSinkId(this.selectedOutputId);
      if (context.state === 'suspended') await context.resume();
      this.toneContext = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.04, now + 0.02);
      gain.gain.setValueAtTime(0.04, now + durationMs / 1000 - 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      oscillator.connect(gain);
      gain.connect(context.destination);
      this.toneNodes.push(oscillator);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
        this.toneNodes = this.toneNodes.filter((node) => node !== oscillator);
      }, { once: true });
      oscillator.start(now);
      oscillator.stop(now + durationMs / 1000);
      return true;
    } catch { return false; }
  }

  async startMicrophoneTest(): Promise<boolean> {
    if (this.closed || !this.microphone || typeof AudioContext === 'undefined') return false;
    await this.stopMicrophoneTest();
    let context: AudioContext | undefined;
    try {
      context = this.audioContextFactory();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const source = context.createMediaStreamSource(this.microphone);
      source.connect(analyser);
      await context.resume();
      this.microphoneTestContext = context;
      this.microphoneTestAnalyser = analyser;
      this.microphoneTestSource = source;
      this.microphoneTestSamples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      return true;
    } catch {
      if (context && context.state !== 'closed') await context.close().catch(() => undefined);
      this.microphoneTestContext = undefined;
      this.microphoneTestAnalyser = undefined;
      this.microphoneTestSource = undefined;
      this.microphoneTestSamples = undefined;
      return false;
    }
  }

  getMicrophoneLevel(): number {
    const analyser = this.microphoneTestAnalyser;
    const samples = this.microphoneTestSamples;
    if (!analyser || !samples) return 0;
    analyser.getByteTimeDomainData(samples);
    let squareSum = 0;
    for (const sample of samples) {
      const amplitude = (sample - 128) / 128;
      squareSum += amplitude * amplitude;
    }
    return Math.min(100, Math.round(Math.sqrt(squareSum / samples.length) * 200));
  }

  async stopMicrophoneTest(): Promise<void> {
    this.microphoneTestSource?.disconnect();
    this.microphoneTestAnalyser?.disconnect();
    const context = this.microphoneTestContext;
    this.microphoneTestSource = undefined;
    this.microphoneTestAnalyser = undefined;
    this.microphoneTestSamples = undefined;
    this.microphoneTestContext = undefined;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }

  async stopMicrophone(): Promise<void> {
    await this.stopMicrophoneTest();
    if (this.microphone) await this.releaseStream(this.microphone);
    this.microphone = undefined;
  }

  async stopDisplayShare(): Promise<void> {
    if (this.displayStream) await this.releaseStream(this.displayStream);
    this.displayStream = undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeHandler);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.pageHideHandler);
    await Promise.all([this.stopMicrophone(), this.stopDisplayShare()]);
    for (const stream of [...this.streams]) await this.releaseStream(stream);
    for (const node of this.toneNodes) { try { node.stop(); node.disconnect(); } catch { /* already stopped */ } }
    this.toneNodes = [];
    if (this.toneContext) {
      const context = this.toneContext;
      this.toneContext = undefined;
      if (context.state !== 'closed') await context.close().catch(() => undefined);
    }
    for (const output of this.outputElements()) {
      output.pause();
      output.srcObject = null;
    }
    this.voiceOutputs.clear();
    this.voiceParticipantVolumes.clear();
    this.transmissionOutput = undefined;
    this.deviceListeners.clear();
  }

  private readonly displayEndedHandler = () => {
    void this.stopDisplayShare();
    this.onDisplayEnded?.();
  };

  private ownStream(stream: MediaStream): void {
    this.streams.add(stream);
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => { void this.detachEverywhere(track); }, { once: true });
    }
  }

  private async releaseStream(stream: MediaStream): Promise<void> {
    this.streams.delete(stream);
    await Promise.all(stream.getTracks().map(async (track) => {
      await this.detachEverywhere(track);
      track.stop();
    }));
  }

  private async detachEverywhere(track: MediaStreamTrack): Promise<void> {
    const peers = [...(this.ownedTracks.get(track) ?? [])];
    await Promise.all(peers.map((peerId) => this.detachTrack(peerId, track).catch(() => undefined)));
  }


  private microphoneTrackEnded(deviceId: string, stream: MediaStream): void {
    if (this.microphone !== stream || this.selectedMicrophoneId !== deviceId) return;
    this.microphone = undefined;
    this.selectedMicrophoneId = undefined;
    void this.releaseStream(stream);
    this.notifyRemoved('audioinput', deviceId);
  }
  private async handleDeviceChange(): Promise<void> {
    if (this.closed) return;
    const [inputs, outputs] = await Promise.all([this.enumerateDevices('audioinput'), this.enumerateDevices('audiooutput')]);
    if (this.selectedMicrophoneId && inputs.state === 'available' && !inputs.devices.some((d) => d.deviceId === this.selectedMicrophoneId)) {
      const removed = this.selectedMicrophoneId;
      this.selectedMicrophoneId = undefined;
      await this.stopMicrophone();
      this.notifyRemoved('audioinput', removed);
    }
    if (this.selectedOutputId && outputs.state === 'available' && !outputs.devices.some((d) => d.deviceId === this.selectedOutputId)) {
      const removed = this.selectedOutputId;
      this.selectedOutputId = undefined;
      for (const output of this.outputElements()) {
        if (typeof output.setSinkId === 'function') void output.setSinkId('').catch(() => undefined);
      }
      this.notifyRemoved('audiooutput', removed);
    }
  }

  private notifyRemoved(kind: MediaDeviceKind, deviceId: string): void {
    this.onDeviceRemoved?.(deviceId);
    for (const listener of this.deviceListeners) listener({ kind, deviceId });
  }
}
