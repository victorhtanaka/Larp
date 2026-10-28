export type VideoContentPreference = 'motion' | 'text';
export type AudioSenderProfile = 'voice' | 'transmission';
export type CpuPressure = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

export interface QualityPeer {
  peerId: string;
  sender: RTCRtpSender;
  peerConnection?: RTCPeerConnection;
  content: VideoContentPreference;
  /** Optional measured estimate from the transport layer; bits per second. */
  availableOutgoingBitrate?: number;
  cpuPressure?: CpuPressure;
}

export interface QualityConfig {
  totalVideoBitrate?: number;
  maxVideoBitratePerPeer?: number;
  maxFrameRate?: number;
}

export interface Metric<T> {
  value: T | null;
  source: 'measured' | 'incoming' | 'unavailable';
}

export interface PeerMediaStats {
  peerId: string;
  direction: 'outgoing';
  resolution: Metric<{ width: number; height: number }>;
  framesPerSecond: Metric<number>;
  codec: Metric<string>;
  uploadBitrate: Metric<number>;
  path: Metric<{ localCandidateType?: string; remoteCandidateType?: string; protocol?: string; relayProtocol?: string }>;
  qualityLimitation: Metric<'cpu' | 'bandwidth' | 'none' | 'other'>;
  /** Available when a caller supplied stats received from the remote peer. */
  incoming?: {
    resolution: Metric<{ width: number; height: number }>;
    framesPerSecond: Metric<number>;
    codec: Metric<string>;
    bitrate: Metric<number>;
    path: Metric<{ localCandidateType?: string; remoteCandidateType?: string; protocol?: string; relayProtocol?: string }>;
  };
}

const unavailable = <T>(): Metric<T> => ({ value: null, source: 'unavailable' });
const measured = <T>(value: T): Metric<T> => ({ value, source: 'measured' });
const incoming = <T>(value: T | null): Metric<T> => ({ value, source: value === null ? 'unavailable' : 'incoming' });
const AUDIO_MAX_BITRATE_BPS: Record<AudioSenderProfile, number> = { voice: 96_000, transmission: 192_000 };
const cpuScale: Record<CpuPressure, number> = { low: 1, moderate: 0.78, high: 0.52, critical: 0.3, unknown: 1 };

/** Allocates video budgets; voice sender caps are configured independently. */
export class MediaQualityController {
  readonly totalVideoBitrate: number;
  readonly maxVideoBitratePerPeer: number;
  readonly maxFrameRate: number;
  private readonly previousBytes = new Map<string, { bytes: number; timestamp: number }>();

  constructor(config: QualityConfig = {}) {
    this.totalVideoBitrate = Math.max(1, config.totalVideoBitrate ?? 20_000_000);
    this.maxVideoBitratePerPeer = Math.max(1, Math.min(config.maxVideoBitratePerPeer ?? 8_000_000, this.totalVideoBitrate));
    this.maxFrameRate = Math.max(1, config.maxFrameRate ?? 60);
  }

  async allocate(peers: QualityPeer[]): Promise<Record<string, number>> {
    const videoPeers = peers.filter(({ sender }) => sender.track?.kind === 'video' && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function');
    const allocation: Record<string, number> = {};
    if (videoPeers.length === 0) return allocation;

    const networkCaps = videoPeers.map((peer) => Number.isFinite(peer.availableOutgoingBitrate) && (peer.availableOutgoingBitrate ?? 0) > 0
      ? peer.availableOutgoingBitrate as number : this.totalVideoBitrate);
    const networkTotal = networkCaps.reduce((sum, value) => sum + value, 0);
    const aggregateBudget = Math.min(this.totalVideoBitrate, networkTotal);
    const weights = videoPeers.map((peer) => (peer.content === 'motion' ? 1.15 : 0.9) * cpuScale[peer.cpuPressure ?? 'unknown']);
    const caps = videoPeers.map((peer, index) => Math.min(this.maxVideoBitratePerPeer, networkCaps[index]));
    const budgets = videoPeers.map(() => 0);
    let remaining = aggregateBudget;
    let active = videoPeers.map((_, index) => index).filter((index) => caps[index] > 0);
    while (remaining > 0.5 && active.length > 0) {
      const totalWeight = active.reduce((sum, index) => sum + weights[index], 0);
      let spent = 0;
      const next: number[] = [];
      for (const index of active) {
        const share = remaining * weights[index] / totalWeight;
        const room = caps[index] - budgets[index];
        const grant = Math.min(room, share);
        budgets[index] += grant;
        spent += grant;
        if (room - grant > 0.5) next.push(index);
      }
      if (spent <= 0.5) break;
      remaining -= spent;
      active = next;
    }

    await Promise.all(videoPeers.map(async (peer, index) => {
      const params = peer.sender.getParameters();
      const encodings = params.encodings?.length ? params.encodings : [{}];
      const bitrate = Math.floor(budgets[index]);
      const cpu = peer.cpuPressure ?? 'unknown';
      const fpsScale = cpu === 'critical' ? 0.4 : cpu === 'high' ? 0.65 : cpu === 'moderate' ? 0.85 : 1;
      const contentFrameRate = peer.content === 'motion' ? this.maxFrameRate : Math.min(30, this.maxFrameRate);
      const frameRate = Math.max(5, Math.floor(contentFrameRate * fpsScale));
      const scaleResolutionDownBy = peer.content === 'text' ? 1 : cpu === 'high' || cpu === 'critical' ? 1.5 : cpu === 'moderate' ? 1.15 : 1;
      params.encodings = encodings.map((encoding, encodingIndex) => ({
        ...encoding,
        maxBitrate: Math.floor(bitrate / encodings.length) + (encodingIndex < bitrate % encodings.length ? 1 : 0),
        maxFramerate: frameRate,
        scaleResolutionDownBy,
      }));
      if (peer.sender.track && 'contentHint' in peer.sender.track) peer.sender.track.contentHint = peer.content === 'motion' ? 'motion' : 'text';
      try {
        await peer.sender.setParameters(params);
        allocation[peer.peerId] = bitrate;
      } catch {
        // Unsupported or concurrently changed encodings remain unreported as applied budgets.
      }
    }));
    return allocation;
  }

  /** Prefer a common codec list supplied by the caller; never assumes hardware acceleration. */
  setCompatibleVideoCodecs(transceiver: RTCRtpTransceiver, remoteMimeTypes: readonly string[]): boolean {
    if (typeof transceiver.setCodecPreferences !== 'function' || typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return false;
    const local = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!local?.length || remoteMimeTypes.length === 0) return false;
    const supportedRemote = new Set(remoteMimeTypes.map((mime) => mime.toLowerCase()));
    const preferences = local.filter((codec) => supportedRemote.has(codec.mimeType.toLowerCase()));
    if (preferences.length === 0) return false;
    const rank = (mime: string): number => mime.toLowerCase() === 'video/av1' ? 0 : mime.toLowerCase() === 'video/vp9' ? 1 : mime.toLowerCase() === 'video/h264' ? 2 : mime.toLowerCase() === 'video/vp8' ? 3 : 4;
    preferences.sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
    transceiver.setCodecPreferences(preferences);
    return true;
  }

  /** Keeps Opus first when both peers support it, with compatible fallbacks retained. */
  setCompatibleAudioCodecs(transceiver: RTCRtpTransceiver, remoteMimeTypes: readonly string[]): boolean {
    if (typeof transceiver.setCodecPreferences !== 'function' || typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return false;
    const local = RTCRtpSender.getCapabilities('audio')?.codecs;
    if (!local?.length || remoteMimeTypes.length === 0) return false;
    const supportedRemote = new Set(remoteMimeTypes.map((mime) => mime.toLowerCase()));
    const preferences = local.filter((codec) => supportedRemote.has(codec.mimeType.toLowerCase()));
    if (preferences.length === 0) return false;
    preferences.sort((a, b) => Number(b.mimeType.toLowerCase() === 'audio/opus') - Number(a.mimeType.toLowerCase() === 'audio/opus'));
    transceiver.setCodecPreferences(preferences);
    return true;
  }
  /** Sets an audio ceiling while leaving WebRTC's congestion control in charge. */
  async configureAudioSender(sender: RTCRtpSender, profile: AudioSenderProfile): Promise<boolean> {
    if (sender.track?.kind !== 'audio') return false;
    const maxBitrate = AUDIO_MAX_BITRATE_BPS[profile];
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return false;
    let changed = false;
    for (const encoding of parameters.encodings) {
      if (encoding.maxBitrate !== undefined && encoding.maxBitrate <= maxBitrate) continue;
      encoding.maxBitrate = maxBitrate;
      changed = true;
    }
    if (!changed) return false;
    await sender.setParameters(parameters);
    return true;
  }


  /** Collects outgoing sender and selected ICE path telemetry where the browser exposes it. */
  async getPeerStats(peer: QualityPeer, incomingStats?: Partial<PeerMediaStats['incoming']>): Promise<PeerMediaStats> {
    const result: PeerMediaStats = {
      peerId: peer.peerId,
      direction: 'outgoing',
      resolution: unavailable(),
      framesPerSecond: unavailable(),
      codec: unavailable(),
      uploadBitrate: unavailable(),
      path: unavailable(),
      qualityLimitation: unavailable(),
    };
    if (incomingStats) {
      result.incoming = {
        resolution: incoming(incomingStats.resolution?.value ?? null),
        framesPerSecond: incoming(incomingStats.framesPerSecond?.value ?? null),
        codec: incoming(incomingStats.codec?.value ?? null),
        bitrate: incoming(incomingStats.bitrate?.value ?? null),
        path: incoming(incomingStats.path?.value ?? null),
      };
    }
    if (typeof peer.sender.getStats !== 'function') return result;
    try {
      const report = await peer.sender.getStats();
      const stats = [...report.values()];
      const outbound = stats.filter((item) => item.type === 'outbound-rtp' && (item as RTCOutboundRtpStreamStats).kind === 'video');
      const current = outbound.find((item) => !(item as RTCOutboundRtpStreamStats & { isRemote?: boolean }).isRemote) as (RTCOutboundRtpStreamStats & { codecId?: string; qualityLimitationReason?: string }) | undefined;
      if (current) {
        const width = current.frameWidth;
        const height = current.frameHeight;
        if (typeof width === 'number' && typeof height === 'number') result.resolution = measured({ width, height });
        if (typeof current.framesPerSecond === 'number') result.framesPerSecond = measured(current.framesPerSecond);
        const limitation = current.qualityLimitationReason;
        if (limitation === 'cpu' || limitation === 'bandwidth' || limitation === 'none') result.qualityLimitation = measured(limitation);
        else if (typeof limitation === 'string') result.qualityLimitation = measured('other');
        const key = `${peer.peerId}:${current.id}`;
        if (typeof current.bytesSent === 'number' && typeof current.timestamp === 'number') {
          const prior = this.previousBytes.get(key);
          if (prior && current.bytesSent >= prior.bytes && current.timestamp > prior.timestamp) {
            result.uploadBitrate = measured((current.bytesSent - prior.bytes) * 8000 / (current.timestamp - prior.timestamp));
          }
          this.previousBytes.set(key, { bytes: current.bytesSent, timestamp: current.timestamp });
        }
        const codec = current.codecId ? stats.find((item) => item.id === current.codecId) as (RTCStats & { mimeType?: string }) | undefined : undefined;
        if (codec?.mimeType) result.codec = measured(codec.mimeType);
      }
      const transport = stats.find((item) => item.type === 'transport') as (RTCStats & { selectedCandidatePairId?: string }) | undefined;
      const candidatePair = transport?.selectedCandidatePairId
        ? stats.find((item) => item.id === transport.selectedCandidatePairId) as (RTCIceCandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string; protocol?: string; relayProtocol?: string }) | undefined
        : stats.find((item) => item.type === 'candidate-pair' && (item as RTCIceCandidatePairStats).state === 'succeeded' && (item as RTCIceCandidatePairStats).nominated) as (RTCIceCandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string; protocol?: string; relayProtocol?: string }) | undefined;
      if (candidatePair) {
        const local = candidatePair.localCandidateId ? stats.find((item) => item.id === candidatePair.localCandidateId) as (RTCStats & { candidateType?: string; relayProtocol?: string }) | undefined : undefined;
        const remote = candidatePair.remoteCandidateId ? stats.find((item) => item.id === candidatePair.remoteCandidateId) as (RTCStats & { candidateType?: string }) | undefined : undefined;
        if (local || remote || candidatePair.protocol) result.path = measured({
          ...(local?.candidateType ? { localCandidateType: local.candidateType } : {}),
          ...(remote?.candidateType ? { remoteCandidateType: remote.candidateType } : {}),
          ...(candidatePair.protocol ? { protocol: candidatePair.protocol } : {}),
          ...(local?.relayProtocol || candidatePair.relayProtocol ? { relayProtocol: local?.relayProtocol ?? candidatePair.relayProtocol } : {}),
        });
      }
    } catch { /* unavailable values remain explicitly marked */ }
    return result;
  }

  forgetPeer(peerId: string): void {
    for (const key of this.previousBytes.keys()) if (key.startsWith(`${peerId}:`)) this.previousBytes.delete(key);
  }
}
