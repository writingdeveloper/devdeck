import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { Store } from './store';
import { registerIpc } from './ipc';

const BASE_DIR = 'C:\\Users\\SIHYEONG\\Documents\\GitHub';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const store = new Store(path.join(app.getPath('userData'), 'state.json'));
  registerIpc({ baseDir: BASE_DIR, store });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
