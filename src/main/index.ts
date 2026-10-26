import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLarpDatabase, type LocalLarpDatabase } from './database';
import { registerIpcHandlers } from './ipc';
import { createLarpRuntime } from './services/runtime';
import { clearDesktopDisplayCapture, consumeDesktopDisplayCapture, hasPreparedDesktopDisplayCapture } from './display-capture';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let database: LocalLarpDatabase | null = null;

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
  if (!database) throw new Error('Banco local ainda não foi inicializado.');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'Larp',
    backgroundColor: '#1A1A1A',

    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devServerOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : undefined;
  const rendererFileUrl = pathToFileURL(
    join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  ).href;
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      if (devServerOrigin && target.origin === devServerOrigin) return;
      if (!devServerOrigin && target.href === rendererFileUrl) return;
    } catch {
      // Invalid navigation targets stay blocked.
    }
    event.preventDefault();
  });


  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    if (mainWindow) clearDesktopDisplayCapture(mainWindow.webContents.id);
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
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
  database = createLarpDatabase(join(userDataPath, 'larp.sqlite'));
  await installPackagedCloudConfig(userDataPath);
  const runtime = await createLarpRuntime(userDataPath);
  registerIpcHandlers(database, () => mainWindow, runtime);
  createWindow();
  void runtime.refreshCloud();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  database?.close();
  database = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
