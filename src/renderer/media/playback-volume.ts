export const DEFAULT_VOICE_PLAYBACK_VOLUME = 1;
export const DEFAULT_TRANSMISSION_PLAYBACK_VOLUME = 1;
const VOICE_PLAYBACK_VOLUME_STORAGE_KEY = 'larp-playback-volume';
const TRANSMISSION_PLAYBACK_VOLUME_STORAGE_KEY = 'larp-transmission-playback-volume';
const VOICE_PARTICIPANT_VOLUMES_STORAGE_KEY = 'larp-voice-participant-volumes';

type PlaybackVolumeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizePlaybackVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_VOICE_PLAYBACK_VOLUME;
}

function loadVolume(storage: Pick<PlaybackVolumeStorage, 'getItem'>, key: string): number {
  try {
    const stored = storage.getItem(key);
    if (stored === null || stored.trim() === '') return DEFAULT_VOICE_PLAYBACK_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) ? normalizePlaybackVolume(volume) : DEFAULT_VOICE_PLAYBACK_VOLUME;
  } catch {
    return DEFAULT_VOICE_PLAYBACK_VOLUME;
  }
}

function saveVolume(storage: Pick<PlaybackVolumeStorage, 'setItem'>, key: string, volume: number): void {
  try {
    storage.setItem(key, String(normalizePlaybackVolume(volume)));
  } catch {
    // Playback remains usable for this session when local storage is unavailable.
  }
}

export function loadVoicePlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'getItem'>): number {
  return loadVolume(storage, VOICE_PLAYBACK_VOLUME_STORAGE_KEY);
}

export function saveVoicePlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'setItem'>, volume: number): void {
  saveVolume(storage, VOICE_PLAYBACK_VOLUME_STORAGE_KEY, volume);
}

export function loadTransmissionPlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'getItem'>): number {
  return loadVolume(storage, TRANSMISSION_PLAYBACK_VOLUME_STORAGE_KEY);
}

export function saveTransmissionPlaybackVolume(storage: Pick<PlaybackVolumeStorage, 'setItem'>, volume: number): void {
  saveVolume(storage, TRANSMISSION_PLAYBACK_VOLUME_STORAGE_KEY, volume);
}

export function loadVoiceParticipantVolumes(storage: Pick<PlaybackVolumeStorage, 'getItem'>): Record<string, number> {
  try {
    const stored = storage.getItem(VOICE_PARTICIPANT_VOLUMES_STORAGE_KEY);
    if (stored === null || stored.trim() === '') return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const volumes: Record<string, number> = {};
    for (const [userId, volume] of Object.entries(parsed)) {
      if (!userId || userId.length > 128 || typeof volume !== 'number' || !Number.isFinite(volume)) continue;
      volumes[userId] = normalizePlaybackVolume(volume);
    }
    return volumes;
  } catch {
    return {};
  }
}

export function saveVoiceParticipantVolumes(
  storage: Pick<PlaybackVolumeStorage, 'setItem'>,
  volumes: Readonly<Record<string, number>>,
): void {
  const normalized: Record<string, number> = {};
  for (const [userId, volume] of Object.entries(volumes)) {
    if (!userId || userId.length > 128 || !Number.isFinite(volume)) continue;
    normalized[userId] = normalizePlaybackVolume(volume);
  }
  try {
    storage.setItem(VOICE_PARTICIPANT_VOLUMES_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Per-user levels remain active in memory if local storage is unavailable.
  }
}
