export const DEFAULT_PLAYBACK_VOLUME = 1;
const PLAYBACK_VOLUME_STORAGE_KEY = 'larp-playback-volume';

type PlaybackVolumeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizePlaybackVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_PLAYBACK_VOLUME;
}

export function loadPlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'getItem'>): number {
  try {
    const stored = storage.getItem(PLAYBACK_VOLUME_STORAGE_KEY);
    if (stored === null || stored.trim() === '') return DEFAULT_PLAYBACK_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) ? normalizePlaybackVolume(volume) : DEFAULT_PLAYBACK_VOLUME;
  } catch {
    return DEFAULT_PLAYBACK_VOLUME;
  }
}

export function savePlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'setItem'>, volume: number): void {
  try {
    storage.setItem(PLAYBACK_VOLUME_STORAGE_KEY, String(normalizePlaybackVolume(volume)));
  } catch {
    // Playback remains usable for this session when local storage is unavailable.
  }
}
