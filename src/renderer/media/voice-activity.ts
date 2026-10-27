export interface VoiceActivityOptions {
  onActiveSpeakers: (participantIds: ReadonlySet<string>) => void;
  audioContextFactory?: () => AudioContext;
  mediaStreamFactory?: (track: MediaStreamTrack) => MediaStream;
  threshold?: number;
  enterSamples?: number;
  exitSamples?: number;
}

interface WatchedTrack {
  participantId: string;
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  ended: () => void;
}

/** Observes caller-owned audio tracks and reports participants whose audio is active. */
export class VoiceActivityMonitor {
  private readonly contextFactory: () => AudioContext;
  private readonly streamFactory: (track: MediaStreamTrack) => MediaStream;
  private readonly threshold: number;
  private readonly enterSamples: number;
  private readonly exitSamples: number;
  private readonly watched = new Map<MediaStreamTrack, WatchedTrack>();
  private readonly active = new Set<string>();
  private readonly above = new Map<string, number>();
  private readonly below = new Map<string, number>();
  private context?: AudioContext;
  private closed = false;

  constructor(private readonly options: VoiceActivityOptions) {
    this.contextFactory = options.audioContextFactory ?? (() => new AudioContext());
    this.streamFactory = options.mediaStreamFactory ?? ((track) => new MediaStream([track]));
    this.threshold = options.threshold ?? 0.035;
    this.enterSamples = options.enterSamples ?? 2;
    this.exitSamples = options.exitSamples ?? 3;
  }

  get activeSpeakers(): ReadonlySet<string> {
    return new Set(this.active);
  }

  addTrack(participantId: string, track: MediaStreamTrack): void {
    if (this.closed || track.kind !== 'audio' || this.watched.has(track)) return;
    try {
      this.context ??= this.contextFactory();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      const source = this.context.createMediaStreamSource(this.streamFactory(track));
      source.connect(analyser);
      const watched: WatchedTrack = {
        participantId, track, source, analyser,
        samples: new Float32Array(analyser.fftSize),
        ended: () => this.removeTrack(track),
      };
      track.addEventListener('ended', watched.ended);
      this.watched.set(track, watched);
    } catch {
      // Audio analysis is optional; capture and calls continue without it.
    }
  }

  removeTrack(track: MediaStreamTrack): void {
    const watched = this.watched.get(track);
    if (!watched) return;
    this.watched.delete(track);
    track.removeEventListener('ended', watched.ended);
    try { watched.source.disconnect(); } catch { /* already disconnected */ }
    if (!this.watchedHasParticipant(watched.participantId)) {
      this.above.delete(watched.participantId);
      this.below.delete(watched.participantId);
      if (this.active.delete(watched.participantId)) this.options.onActiveSpeakers(new Set(this.active));
      return;
    }
    this.reconcileParticipant(watched.participantId, false);
  }

  /** Sample once; callers may schedule this at a modest interval (for example, 100 ms). */
  sample(): void {
    if (this.closed || this.watched.size === 0) return;
    const rmsByParticipant = new Map<string, number>();
    for (const watched of this.watched.values()) {
      watched.analyser.getFloatTimeDomainData(watched.samples);
      let sum = 0;
      for (const sample of watched.samples) sum += sample * sample;
      const rms = Math.sqrt(sum / watched.samples.length);
      rmsByParticipant.set(watched.participantId, Math.max(rmsByParticipant.get(watched.participantId) ?? 0, rms));
    }
    const participants = new Set([...rmsByParticipant.keys(), ...this.active]);
    for (const id of participants) this.reconcileParticipant(id, (rmsByParticipant.get(id) ?? 0) >= this.threshold);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const watched of this.watched.values()) {
      watched.track.removeEventListener('ended', watched.ended);
      try { watched.source.disconnect(); } catch { /* already disconnected */ }
    }
    this.watched.clear();
    this.above.clear();
    this.below.clear();
    const changed = this.active.size > 0;
    this.active.clear();
    if (changed) this.options.onActiveSpeakers(new Set());
    const context = this.context;
    this.context = undefined;
    try { await context?.close(); } catch { /* best-effort cleanup */ }
  }

  private reconcileParticipant(id: string, loud: boolean): void {
    const count = loud ? (this.above.get(id) ?? 0) + 1 : (this.below.get(id) ?? 0) + 1;
    if (loud) {
      this.above.set(id, count);
      this.below.delete(id);
      if (!this.active.has(id) && count >= this.enterSamples) {
        this.active.add(id);
        this.options.onActiveSpeakers(new Set(this.active));
      }
    } else {
      this.below.set(id, count);
      this.above.delete(id);
      if (this.active.has(id) && count >= this.exitSamples) {
        this.active.delete(id);
        this.options.onActiveSpeakers(new Set(this.active));
      }
      if (!this.watchedHasParticipant(id) && !this.active.has(id)) {
        this.above.delete(id);
        this.below.delete(id);
      }
    }
  }

  private watchedHasParticipant(id: string): boolean {
    for (const watched of this.watched.values()) if (watched.participantId === id) return true;
    return false;
  }
}
