export const DEFAULT_NOISE_SUPPRESSION = true;
const NOISE_SUPPRESSION_STORAGE_KEY = 'larp-noise-suppression';

type NoiseSuppressionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export default DEFAULT_NOISE_SUPPRESSION;

export function loadNoiseSuppression(storage: Pick<NoiseSuppressionStorage, 'getItem'>): boolean {
  try {
    const stored = storage.getItem(NOISE_SUPPRESSION_STORAGE_KEY);
    if (stored === null) return DEFAULT_NOISE_SUPPRESSION;
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === 'boolean' ? parsed : DEFAULT_NOISE_SUPPRESSION;
  } catch {
    return DEFAULT_NOISE_SUPPRESSION;
  }
}

export function saveNoiseSuppression(storage: Pick<NoiseSuppressionStorage, 'setItem'>, enabled: boolean): void {
  try {
    storage.setItem(NOISE_SUPPRESSION_STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // Capture remains usable when local storage is unavailable.
  }
}
