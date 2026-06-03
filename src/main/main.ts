import { app, BrowserWindow, globalShortcut } from 'electron';
import * as path from 'node:path';
import { Store } from './store';
import { registerIpc } from './ipc';
import { setupTray } from './tray';

const DEFAULT_BASE_DIR = 'C:\\Users\\SIHYEONG\\Documents\\GitHub';

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return w;
}

function showWindow(): void {
  if (!win) return;
  win.show();
  win.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    const store = new Store(path.join(app.getPath('userData'), 'state.json'));
    win = createWindow();
    registerIpc({
      defaultBaseDir: DEFAULT_BASE_DIR,
      store,
      sendError: (msg) => win?.webContents.send('devdeck:error', msg),
      defaultLanguage: app.getLocale().split('-')[0] || 'en',
    });
    setupTray(win);
    globalShortcut.register('Control+Alt+D', showWindow);
    app.on('activate', () => { if (!win) win = createWindow(); });
  });

  app.on('window-all-closed', () => { /* stay alive in tray */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
