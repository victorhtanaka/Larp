export type RemoteAudioTrackAddition = 'peer-joined' | 'track-added' | 'duplicate';
export type RemoteAudioTrackRemoval = 'peer-left' | 'track-removed' | 'unknown';

export class RemoteAudioParticipants {
  private readonly tracksByPeer = new Map<string, Set<MediaStreamTrack>>();

  get peerIds(): readonly string[] {
    return [...this.tracksByPeer.keys()];
  }

  add(peerId: string, track: MediaStreamTrack): RemoteAudioTrackAddition {
    const tracks = this.tracksByPeer.get(peerId);
    if (tracks?.has(track)) return 'duplicate';
    if (tracks) {
      tracks.add(track);
      return 'track-added';
    }
    this.tracksByPeer.set(peerId, new Set([track]));
    return 'peer-joined';
  }

  remove(peerId: string, track: MediaStreamTrack): RemoteAudioTrackRemoval {
    const tracks = this.tracksByPeer.get(peerId);
    if (!tracks?.delete(track)) return 'unknown';
    if (tracks.size > 0) return 'track-removed';
    this.tracksByPeer.delete(peerId);
    return 'peer-left';
  }

  clear(): void {
    this.tracksByPeer.clear();
  }
}
