import squirrelStartup from 'electron-squirrel-startup';
import { app, BrowserWindow, desktopCapturer, dialog, session } from 'electron';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeCore, type NativeCoreClient } from './native-core';
import { registerIpcHandlers } from './ipc';
import { createNativeHostCall } from './native-host-calls';
import { handleSecretsCall } from './platform-secrets';
import { loadSupabaseClientConfiguration } from './supabase-config';
import { createSupabaseTransport, type SupabaseTransport } from './supabase-transport';
import { clearDesktopDisplayCapture, consumeDesktopDisplayCapture, hasPreparedDesktopDisplayCapture } from './display-capture';
import { closeStartupUpdater, runStartupUpdater } from './updater';
import { getAppIconPath } from './app-icon';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let nativeCore: NativeCoreClient | null = null;
let supabaseTransport: SupabaseTransport | undefined;
let routeNativeCoreEvent = (_eventJson: string): void => {};
let isAppStarting = true;
let startupFailureReported = false;
let nativeCoreShutdown: Promise<void> | undefined;
const appUserModelId = 'com.squirrel.Larp.Larp';
app.setAppUserModelId(appUserModelId);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Larp-dev'));
}

function reportStartupFailure(error: unknown): void {
  if (startupFailureReported) return;
  startupFailureReported = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.error('Não foi possível iniciar o Larp:', error);
  closeStartupUpdater();
  dialog.showErrorBox('Não foi possível iniciar o Larp', detail);
  app.quit();
}


async function installPackagedCloudConfig(userDataPath: string): Promise<void> {
  if (!app.isPackaged) return;
  try {
    await copyFile(
      join(process.resourcesPath, 'default-cloud-config.json'),
      join(userDataPath, 'config.json'),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
}

function createWindow(): void {
  if (!nativeCore) throw new Error('Banco local ainda não foi inicializado.');

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'Larp',
    backgroundColor: '#0a0a0a',
    icon: getAppIconPath(),

    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  const webContentsId = window.webContents.id;

  window.once('ready-to-show', () => {
    window.webContents.setZoomFactor(1.25);
    window.show();
    closeStartupUpdater();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devServerOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : undefined;
  const rendererFileUrl = pathToFileURL(
    join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
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


  const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : window.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  void load.catch(reportStartupFailure);

  window.on('closed', () => {
    clearDesktopDisplayCapture(webContentsId);
    if (mainWindow === window) mainWindow = null;
  });
}

if (!squirrelStartup && hasSingleInstanceLock) app.whenReady().then(async () => {
  const shouldStartApp = await runStartupUpdater();
  if (!shouldStartApp) return;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trustedWindow = mainWindow !== null && BrowserWindow.fromWebContents(webContents) === mainWindow;
    const requested = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
    const allowMicrophone = trustedWindow && permission === 'media'
      && requested.includes('audio') && !requested.includes('video');
    const allowDisplay = trustedWindow && permission === 'display-capture'
      && requested.includes('video') && hasPreparedDesktopDisplayCapture(webContents.id);
    callback(allowMicrophone || allowDisplay);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    if (!webContents || mainWindow === null || BrowserWindow.fromWebContents(webContents) !== mainWindow || !details.isMainFrame) return false;
    if (permission === 'media') return details.mediaType === 'audio';
    if (permission === 'display-capture') return details.mediaType === 'video' && hasPreparedDesktopDisplayCapture(webContents.id);
    return false;
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void (async () => {
      const selection = await consumeDesktopDisplayCapture(request.frame, mainWindow);
      if (!selection || !request.videoRequested) {
        callback(null);
        return;
      }
      const source = (await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      })).find((candidate) => candidate.id === selection.sourceId);
      if (!source) {
        callback(null);
        return;
      }
      callback({
        video: source,
        ...(selection.audio && request.audioRequested ? { audio: 'loopback' as const } : {}),
      });
    })().catch(() => callback(null));
  });
  const userDataPath = app.getPath('userData');
  await installPackagedCloudConfig(userDataPath);
  const configuration = await loadSupabaseClientConfiguration(join(userDataPath, 'config.json'));
  const cloudConfig = configuration.status === 'configured'
    ? { url: configuration.url, anonKey: configuration.anonKey }
    : null;
  const hostCall = createNativeHostCall({ secrets: handleSecretsCall, cloud: () => supabaseTransport });
  const core = await createNativeCore(userDataPath, cloudConfig, hostCall, (eventJson) => routeNativeCoreEvent(eventJson));
  nativeCore = core;
  if (cloudConfig) {
    supabaseTransport = createSupabaseTransport(
      cloudConfig.url,
      cloudConfig.anonKey,
      (subscriptionId, epoch, eventJson) => core.ingestCloudEvent(subscriptionId, epoch, eventJson),
    );
  }
  routeNativeCoreEvent = registerIpcHandlers(core, () => mainWindow);
  createWindow();
  isAppStarting = false;
  void core.request({ version: 1, op: 'refreshCloud', payload: {} }).catch((error: unknown) => {
    console.error('Não foi possível atualizar o estado cloud:', error);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(reportStartupFailure);

app.on('before-quit', (event) => {
  if (nativeCoreShutdown) {
    event.preventDefault();
    return;
  }
  if (!nativeCore) return;
  event.preventDefault();
  const closingCore = nativeCore;
  nativeCore = null;
  nativeCoreShutdown = closingCore.close()
    .catch((error: unknown) => { console.error('Não foi possível fechar o núcleo nativo:', error); })
    .finally(() => {
      nativeCoreShutdown = undefined;
      app.quit();
    });
});
if (!hasSingleInstanceLock) app.quit();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isAppStarting) app.quit();
});
