import { app, autoUpdater, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UpdaterViewState } from '../updater/contracts';
import { getAppIconPath } from './app-icon';

declare const UPDATER_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const UPDATER_WINDOW_VITE_NAME: string;

const updateFeedUrl = 'https://github.com/victorhtanaka/Larp/releases/latest/download';
const checkTimeoutMs = 30_000;
const downloadTimeoutMs = 15 * 60_000;
const errorContinueDelayMs = 6_000;
const currentContinueDelayMs = 650;
const installDelayMs = 450;

let startupUpdaterWindow: BrowserWindow | null = null;

function createUpdaterWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 430,
    height: 250,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: 'Larp — Atualização',
    backgroundColor: '#0a0a0a',
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, 'updater-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.center();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devServerOrigin = UPDATER_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(UPDATER_WINDOW_VITE_DEV_SERVER_URL).origin
    : undefined;
  const rendererFileUrl = pathToFileURL(
    join(__dirname, `../renderer/${UPDATER_WINDOW_VITE_NAME}/index.html`),
  ).href;
  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      if (devServerOrigin && target.origin === devServerOrigin) return;
      if (!devServerOrigin && target.href === rendererFileUrl) return;
    } catch {
      // Invalid navigation targets stay blocked.
    }
    event.preventDefault();
  });

  return window;
}

async function loadUpdaterWindow(window: BrowserWindow): Promise<void> {
  if (UPDATER_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(UPDATER_WINDOW_VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(join(__dirname, `../renderer/${UPDATER_WINDOW_VITE_NAME}/index.html`));
}

function isTrustedUpdaterFrame(event: IpcMainEvent, window: BrowserWindow): boolean {
  return !window.isDestroyed()
    && BrowserWindow.fromWebContents(event.sender) === window
    && event.senderFrame === event.sender.mainFrame;
}

export function closeStartupUpdater(): void {
  const window = startupUpdaterWindow;
  startupUpdaterWindow = null;
  if (window && !window.isDestroyed()) window.close();
}

export function runStartupUpdater(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'win32' || process.argv.includes('--squirrel-firstrun')) {
    return Promise.resolve(true);
  }

  const { promise, resolve } = Promise.withResolvers<boolean>();
  let window: BrowserWindow;
  try {
    window = createUpdaterWindow();
  } catch (error) {
    console.error('Não foi possível criar a janela de atualização:', error);
    resolve(true);
    return promise;
  }
  startupUpdaterWindow = window;

  try {
    autoUpdater.setFeedURL({ url: updateFeedUrl });
  } catch (error) {
    console.error('Não foi possível configurar a origem de atualizações:', error);
    closeStartupUpdater();
    resolve(true);
    return promise;
  }

  let settled = false;
  let retryAvailable = false;
  let continueAvailable = false;
  let requestTimer: NodeJS.Timeout | undefined;
  let actionTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    clearTimeout(requestTimer);
    clearTimeout(actionTimer);
    requestTimer = undefined;
    actionTimer = undefined;
  };

  const setState = (state: UpdaterViewState): void => {
    if (!window.isDestroyed()) window.webContents.send('updater:state', state);
  };

  const removeListeners = (): void => {
    autoUpdater.removeListener('checking-for-update', onChecking);
    autoUpdater.removeListener('update-available', onUpdateAvailable);
    autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
    autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
    autoUpdater.removeListener('error', onError);
    ipcMain.removeListener('updater:retry', onRetry);
    ipcMain.removeListener('updater:continue', onContinue);
    window.removeListener('closed', onWindowClosed);
    window.webContents.removeListener('did-fail-load', onLoadFailed);
  };

  const finish = (startApplication: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    removeListeners();
    if (startApplication) {
      setState({ state: 'opening', version: app.getVersion(), canRetry: false });
    }
    resolve(startApplication);
  };

  const showError = (canRetry: boolean): void => {
    if (settled) return;
    clearTimeout(requestTimer);
    requestTimer = undefined;
    retryAvailable = canRetry;
    continueAvailable = true;
    setState({ state: 'error', version: app.getVersion(), canRetry });
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => finish(true), errorContinueDelayMs);
  };

  const startCheck = (): void => {
    if (settled) return;
    clearTimeout(requestTimer);
    clearTimeout(actionTimer);
    requestTimer = undefined;
    actionTimer = undefined;
    retryAvailable = false;
    continueAvailable = false;
    setState({ state: 'checking', version: app.getVersion(), canRetry: false });
    requestTimer = setTimeout(() => showError(false), checkTimeoutMs);
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('A verificação de atualizações falhou:', error);
      showError(true);
    }
  };

  const onChecking = (): void => {
    if (!settled) setState({ state: 'checking', version: app.getVersion(), canRetry: false });
  };
  const onUpdateAvailable = (): void => {
    if (settled) return;
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => showError(false), downloadTimeoutMs);
    setState({ state: 'downloading', version: app.getVersion(), canRetry: false });
    continueAvailable = false;
  };
  const onUpdateNotAvailable = (): void => {
    if (settled) return;
    clearTimeout(requestTimer);
    requestTimer = undefined;
    setState({ state: 'current', version: app.getVersion(), canRetry: false });
    actionTimer = setTimeout(() => finish(true), currentContinueDelayMs);
    continueAvailable = false;
  };
  const onUpdateDownloaded = (): void => {
    if (settled) return;
    clearTimers();
    setState({ state: 'installing', version: app.getVersion(), canRetry: false });
    actionTimer = setTimeout(() => {
      finish(false);
      autoUpdater.quitAndInstall();
    }, installDelayMs);
    continueAvailable = false;
  };
  const onError = (error: Error): void => {
    console.error('A atualização do Larp falhou:', error);
    showError(true);
  };
  const onRetry = (event: IpcMainEvent): void => {
    if (!isTrustedUpdaterFrame(event, window) || !retryAvailable || settled) return;
    startCheck();
  };
  const onContinue = (event: IpcMainEvent): void => {
    if (!isTrustedUpdaterFrame(event, window) || !continueAvailable || settled) return;
    finish(true);
  };
  const onWindowClosed = (): void => {
    if (startupUpdaterWindow === window) startupUpdaterWindow = null;
    finish(true);
  };
  const onLoadFailed = (): void => finish(true);

  autoUpdater.on('checking-for-update', onChecking);
  autoUpdater.on('update-available', onUpdateAvailable);
  autoUpdater.on('update-not-available', onUpdateNotAvailable);
  autoUpdater.on('update-downloaded', onUpdateDownloaded);
  autoUpdater.on('error', onError);
  ipcMain.on('updater:retry', onRetry);
  ipcMain.on('updater:continue', onContinue);
  window.on('closed', onWindowClosed);
  window.webContents.once('did-fail-load', onLoadFailed);

  void loadUpdaterWindow(window).then(() => {
    if (settled) return;
    window.show();
    startCheck();
  }).catch((error: unknown) => {
    console.error('Não foi possível abrir a janela de atualização:', error);
    finish(true);
  });
  return promise;
}
