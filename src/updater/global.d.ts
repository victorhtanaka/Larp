import type { UpdaterBridge } from './contracts';

declare global {
  interface Window {
    larpUpdater: UpdaterBridge;
  }
}

export {};
