import { app, ipcMain, type BrowserWindow } from 'electron';
import { wireUpdater, shouldAutoCheck } from '../shared/update';

/** Wire electron-updater to the renderer. Inert in dev (unpackaged). Errors are logged, never surfaced. */
export function registerUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return;
  let autoUpdater: unknown;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // dependency unavailable — skip silently
  }
  const api = wireUpdater(
    autoUpdater as Parameters<typeof wireUpdater>[0],
    (p) => win.webContents.send('devdeck:update', p),
    (e) => console.error('DevDeck update:', e),
  );
  ipcMain.handle('update:download', () => api.download());
  ipcMain.handle('update:install', () => api.install());
  ipcMain.handle('update:check', () => {
    win.webContents.send('devdeck:update', { status: 'checking' });
    api.check();
  });
  if (shouldAutoCheck(process.platform)) win.webContents.once('did-finish-load', () => api.check());
}
