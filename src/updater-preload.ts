import { contextBridge, ipcRenderer } from 'electron';
import type { UpdaterBridge, UpdaterViewState } from './updater/contracts';

const bridge: UpdaterBridge = Object.freeze({
  subscribe(onState: (state: UpdaterViewState) => void) {
    let active = true;
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterViewState): void => {
      if (active) onState(state);
    };
    ipcRenderer.on('updater:state', listener);
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener('updater:state', listener);
    };
  },
  retry: () => ipcRenderer.send('updater:retry'),
  continueWithoutUpdate: () => ipcRenderer.send('updater:continue'),
});

contextBridge.exposeInMainWorld('larpUpdater', bridge);
