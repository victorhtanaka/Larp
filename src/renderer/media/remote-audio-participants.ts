import type { PeerConnectionStatus } from '../rtc/peer-mesh';

export type RemoteAudioSource = 'voice' | 'transmission';

export interface RemoteAudioTrackRecord {
  peerId: string;
  track: MediaStreamTrack;
  streamIds: Set<string>;
  source: RemoteAudioSource;
}

export interface RemoteAudioSourceChange {
  record: RemoteAudioTrackRecord;
  previousSource: RemoteAudioSource;
  source: RemoteAudioSource;
  peerJoined: boolean;
  peerLeft: boolean;
}

export class RemoteAudioParticipants {
  private readonly tracksByPeer = new Map<string, Map<MediaStreamTrack, RemoteAudioTrackRecord>>();
  private readonly videoStreamIdsByPeer = new Map<string, Set<string>>();
  private readonly peerStates = new Map<string, PeerConnectionStatus>();
  private readonly voiceActiveByPeer = new Map<string, boolean>();
  private readonly participatingPeers = new Set<string>();

  get peerIds(): readonly string[] {
    return [...this.participatingPeers];
  }

  get records(): readonly RemoteAudioTrackRecord[] {
    return [...this.tracksByPeer.values()].flatMap((tracks) => [...tracks.values()]);
  }

  getPeerState(peerId: string): PeerConnectionStatus | undefined {
    return this.peerStates.get(peerId);
  }

  setPeerState(peerId: string, state: PeerConnectionStatus): void {
    this.peerStates.set(peerId, state);
    this.updateVoiceParticipation(peerId);
  }

  setVoiceActive(peerId: string, active: boolean): {
    records: RemoteAudioTrackRecord[];
    peerJoined: boolean;
    peerLeft: boolean;
  } {
    const wasParticipating = this.participatingPeers.has(peerId);
    this.voiceActiveByPeer.set(peerId, active);
    this.updateVoiceParticipation(peerId);
    const isParticipating = this.participatingPeers.has(peerId);
    return {
      records: [...(this.tracksByPeer.get(peerId)?.values() ?? [])].filter((record) => record.source === 'voice'),
      peerJoined: !wasParticipating && isParticipating,
      peerLeft: wasParticipating && !isParticipating,
    };
  }

  removeSource(peerId: string, source: RemoteAudioSource): {
    records: RemoteAudioTrackRecord[];
    peerLeft: boolean;
  } {
    const tracks = this.tracksByPeer.get(peerId);
    if (!tracks) return { records: [], peerLeft: false };
    const wasParticipating = this.participatingPeers.has(peerId);
    const records: RemoteAudioTrackRecord[] = [];
    for (const [track, record] of tracks) {
      if (record.source !== source) continue;
      tracks.delete(track);
      records.push(record);
    }
    if (tracks.size === 0) this.tracksByPeer.delete(peerId);
    this.updateVoiceParticipation(peerId);
    return {
      records,
      peerLeft: wasParticipating && !this.participatingPeers.has(peerId),
    };
  }

  videoStreamIds(peerId: string): readonly string[] {
    return [...(this.videoStreamIdsByPeer.get(peerId) ?? [])];
  }

  clearVideoStreams(peerId: string): void {
    this.videoStreamIdsByPeer.delete(peerId);
  }


  addAudioTrack(peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]): { record: RemoteAudioTrackRecord; added: boolean } {
    const existingTracks = this.tracksByPeer.get(peerId);
    const tracks = existingTracks ?? new Map<MediaStreamTrack, RemoteAudioTrackRecord>();
    if (!existingTracks) this.tracksByPeer.set(peerId, tracks);
    let record = tracks.get(track);
    const added = !record;
    if (!record) {
      record = { peerId, track, streamIds: new Set<string>(), source: 'voice' };
      tracks.set(track, record);
    }
    for (const stream of streams) {
      record.streamIds.add(stream.id);
      if (stream.getVideoTracks().length > 0) this.addVideoStreamId(peerId, stream.id);
    }
    return { record, added };
  }

  addVideoStreams(peerId: string, streams: readonly MediaStream[]): RemoteAudioSourceChange[] {
    for (const stream of streams) this.addVideoStreamId(peerId, stream.id);
    const changes: RemoteAudioSourceChange[] = [];
    for (const record of this.tracksByPeer.get(peerId)?.values() ?? []) {
      if (!this.isTransmission(record)) continue;
      const change = this.setSource(record, 'transmission');
      if (change.previousSource !== change.source) changes.push(change);
    }
    return changes;
  }

  isTransmission(record: RemoteAudioTrackRecord): boolean {
    const videoStreamIds = this.videoStreamIdsByPeer.get(record.peerId);
    if (!videoStreamIds) return false;
    for (const streamId of record.streamIds) {
      if (videoStreamIds.has(streamId)) return true;
    }
    return false;
  }

  setSource(record: RemoteAudioTrackRecord, source: RemoteAudioSource): RemoteAudioSourceChange {
    const wasParticipating = this.participatingPeers.has(record.peerId);
    const previousSource = record.source;
    record.source = source;
    this.updateVoiceParticipation(record.peerId);
    const isParticipating = this.participatingPeers.has(record.peerId);
    return {
      record,
      previousSource,
      source,
      peerJoined: !wasParticipating && isParticipating,
      peerLeft: wasParticipating && !isParticipating,
    };
  }

  removeTrack(peerId: string, track: MediaStreamTrack): { record?: RemoteAudioTrackRecord; peerLeft: boolean } {
    const tracks = this.tracksByPeer.get(peerId);
    const record = tracks?.get(track);
    if (!tracks || !record) return { peerLeft: false };
    const wasParticipating = this.participatingPeers.has(peerId);
    tracks.delete(track);
    if (tracks.size === 0) this.tracksByPeer.delete(peerId);
    this.updateVoiceParticipation(peerId);
    return { record, peerLeft: wasParticipating && !this.participatingPeers.has(peerId) };
  }

  removePeer(peerId: string): RemoteAudioTrackRecord[] {
    const records = [...(this.tracksByPeer.get(peerId)?.values() ?? [])];
    this.tracksByPeer.delete(peerId);
    this.videoStreamIdsByPeer.delete(peerId);
    this.voiceActiveByPeer.delete(peerId);
    this.peerStates.delete(peerId);
    this.participatingPeers.delete(peerId);
    return records;
  }

  clear(): void {
    this.tracksByPeer.clear();
    this.videoStreamIdsByPeer.clear();
    this.voiceActiveByPeer.clear();
    this.peerStates.clear();
    this.participatingPeers.clear();
  }

  private addVideoStreamId(peerId: string, streamId: string): void {
    let ids = this.videoStreamIdsByPeer.get(peerId);
    if (!ids) {
      ids = new Set();
      this.videoStreamIdsByPeer.set(peerId, ids);
    }
    ids.add(streamId);
  }

  private updateVoiceParticipation(peerId: string): void {
    const tracks = this.tracksByPeer.get(peerId);
    let hasVoiceTrack = false;
    if (tracks) {
      for (const record of tracks.values()) {
        if (record.source === 'voice') {
          hasVoiceTrack = true;
          break;
        }
      }
    }
    if (this.voiceActiveByPeer.get(peerId) === false) {
      this.participatingPeers.delete(peerId);
      return;
    }

    if (hasVoiceTrack) {
      this.participatingPeers.add(peerId);
      return;
    }
    const state = this.peerStates.get(peerId);
    if (state !== 'disconnected' && state !== 'failed' && state !== 'connecting') {
      this.participatingPeers.delete(peerId);
    }
  }
}
