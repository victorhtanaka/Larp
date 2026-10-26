import { app } from 'electron';
import { join } from 'node:path';

export function getAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'larp-icon.ico')
    : join(app.getAppPath(), 'src', 'assets', 'larp-icon.ico');
}
