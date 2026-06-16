import { app, BrowserWindow, globalShortcut } from 'electron';
import * as path from 'node:path';
import * as nodePty from '@homebridge/node-pty-prebuilt-multiarch';
import { Store } from './store';
import { registerIpc } from './ipc';
import { PtyHost, type PtySpawn } from './ptyHost';
import { setupTray } from './tray';
import { registerUpdater } from './updater';
import { applyOpenAtLogin } from './autostart';

const realSpawn: PtySpawn = (file, args, opts) => {
  const p = nodePty.spawn(file, args, { name: 'xterm-256color', cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
  return {
    pid: p.pid,
    onData: (cb) => { p.onData(cb); },
    onExit: (cb) => { p.onExit((e) => cb({ exitCode: e.exitCode })); },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
  };
};
const ptyHost = new PtyHost(realSpawn);

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0d0e12',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
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
    // Match the installer shortcut's AppUserModelID (electron-builder sets it to
    // the appId) so Windows shows the DevDeck taskbar icon and groups windows
    // correctly. Without this the running process uses Electron's default ID and
    // the taskbar falls back to the generic Electron icon.
    if (process.platform === 'win32') app.setAppUserModelId('com.soursea.devdeck');
    const store = new Store(path.join(app.getPath('userData'), 'state.json'));
    // Reconcile the OS login item with the saved preference (e.g. after a
    // reinstall/update the registered exe path may be stale). No-op in dev / off Windows.
    applyOpenAtLogin(store.getOpenAtLogin());
    const w = createWindow();
    win = w;
    const tray = setupTray(w);
    registerIpc({
      win: w,
      defaultBaseDir: path.join(app.getPath('home'), 'Documents', 'GitHub'),
      store,
      sendError: (msg) => w.webContents.send('devdeck:error', msg),
      defaultLanguage: app.getLocale().split('-')[0] || 'en',
      ptyHost,
      tray,
    });
    registerUpdater(w);
    globalShortcut.register('Control+Alt+D', showWindow);
    app.on('activate', () => { if (!win) win = createWindow(); });
  });

  app.on('window-all-closed', () => { /* stay alive in tray */ });
  app.on('before-quit', () => ptyHost.killAll());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
