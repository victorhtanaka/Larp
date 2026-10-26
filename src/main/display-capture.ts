import { BrowserWindow, desktopCapturer, webContents, type WebFrameMain } from 'electron';
import type { SelectedDisplaySource } from '../shared/contracts';

interface PendingDisplayCapture {
  sourceId: string;
  audio: boolean;
  expiresAt: number;
}

const selectionLifetimeMs = 30_000;
const pendingSelections = new Map<number, PendingDisplayCapture>();

async function getDesktopSources() {
  return desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
}

function sourceKind(sourceId: string): SelectedDisplaySource['kind'] | undefined {
  if (sourceId.startsWith('screen:')) return 'screen';
  if (sourceId.startsWith('window:')) return 'window';
  return undefined;
}

export async function listDesktopDisplaySources(): Promise<SelectedDisplaySource[]> {
  const sources = await getDesktopSources();
  return sources.flatMap((source) => {
    const kind = sourceKind(source.id);
    if (!kind || !source.id || source.id.length > 512) return [];
    return [{ id: source.id, name: source.name.slice(0, 256) || 'Janela sem nome', kind }];
  });
}

export async function prepareDesktopDisplayCapture(webContentsId: number, sourceId: string, audio: boolean): Promise<void> {
  if (!Number.isSafeInteger(webContentsId) || webContentsId < 1
    || typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 512
    || typeof audio !== 'boolean') {
    throw new TypeError('A fonte de captura selecionada é inválida.');
  }
  const kind = sourceKind(sourceId);
  if (!kind || !(await listDesktopDisplaySources()).some((source) => source.id === sourceId && source.kind === kind)) {
    throw new Error('A tela ou janela selecionada não está mais disponível.');
  }
  pendingSelections.set(webContentsId, { sourceId, audio, expiresAt: Date.now() + selectionLifetimeMs });
}

export function hasPreparedDesktopDisplayCapture(webContentsId: number): boolean {
  const selection = pendingSelections.get(webContentsId);
  if (!selection || selection.expiresAt <= Date.now()) {
    pendingSelections.delete(webContentsId);
    return false;
  }
  return true;
}

export async function consumeDesktopDisplayCapture(frame: WebFrameMain | null, targetWindow: BrowserWindow | null): Promise<PendingDisplayCapture | undefined> {
  if (!frame || !targetWindow || frame.top !== frame
    || webContents.fromFrame(frame) !== targetWindow.webContents
    || frame.url !== targetWindow.webContents.getURL()) return undefined;
  const selection = pendingSelections.get(targetWindow.webContents.id);
  pendingSelections.delete(targetWindow.webContents.id);
  if (!selection || selection.expiresAt <= Date.now()) return undefined;
  const sourceExists = (await listDesktopDisplaySources()).some((source) => source.id === selection.sourceId);
  return sourceExists ? selection : undefined;
}

export function clearDesktopDisplayCapture(webContentsId: number): void {
  pendingSelections.delete(webContentsId);
}
