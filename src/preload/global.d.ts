import type { LarpBridge } from '../shared/contracts';

declare global {
  interface Window {
    larp: LarpBridge;
  }
}

export {};
