import { app, BrowserWindow, globalShortcut, crashReporter } from 'electron';
import * as path from 'node:path';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { uptime, homedir } from 'node:os';
import { Store } from './store';
import { registerIpc } from './ipc';
import { PtyHost, type PtySpawn } from './ptyHost';
import { setupTray } from './tray';
import { registerUpdater } from './updater';
import { applyOpenAtLogin } from './autostart';
import { installGlobalErrorHandlers, installAppCrashHandlers, makeCrashRecovery } from './errorGuard';
import { ShutdownLog } from './shutdownLog';
import { ShutdownScheduler } from './shutdownScheduler';
import { latestTranscriptMtime } from './transcriptFreshness';

// Local-only crash capture (no upload — nothing is ever sent anywhere) so a NATIVE crash (a fault
// inside node-pty/conpty or Chromium itself) writes an inspectable minidump instead of vanishing —
// by default Electron's bundled Crashpad handler swallows unconfigured native crashes silently,
// leaving no Windows Event Log entry and no trace in our own JS-level error guard below.
crashReporter.start({ uploadToServer: false, compress: true });

// node-pty backs the win32-only cockpit. A top-level import made its native binding a BOOT
// dependency on every OS — on Linux/macOS a missing prebuilt for this exact Electron ABI threw
// during main.js load, so the app never showed a window at all. Guarded require: everything but
// the cockpit works without it, and the cockpit is hidden off-Windows anyway.
type NodePty = typeof import('@homebridge/node-pty-prebuilt-multiarch');
let nodePty: NodePty | null = null;
try { nodePty = require('@homebridge/node-pty-prebuilt-multiarch') as NodePty; } catch { nodePty = null; }

const realSpawn: PtySpawn = (file, args, opts) => {
  if (!nodePty) throw new Error('node-pty native binding unavailable — embedded terminals need Windows (or a matching prebuilt)');
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
    const userData = app.getPath('userData');
    // Every diagnostic line includes a memory snapshot: if DevDeck is dying to a V8
    // "JavaScript heap out of memory" abort (long cockpit sessions accumulating buffered output),
    // that abort itself bypasses uncaughtException — but a rising rss/heapUsed trend across
    // whatever DID get logged before it is the only way to notice the pattern after the fact.
    const logLine = (line: string): void => {
      const m = process.memoryUsage();
      const withMem = `${line} | rss=${Math.round(m.rss / 1048576)}MB heapUsed=${Math.round(m.heapUsed / 1048576)}MB`;
      console.error('DevDeck', withMem);
      try { appendFileSync(path.join(userData, 'devdeck-errors.log'), `${new Date().toISOString()} ${withMem}\n`); } catch { /* logging is best-effort */ }
    };
    // Last-resort trap: keep the main process alive when an async callback (pty data/exit, the
    // PtyBatcher flush timer, a git spawn, a stray IPC reject) throws. Before this, such a throw
    // closed DevDeck "out of nowhere" and took every cockpit terminal with it.
    installGlobalErrorHandlers((kind, err) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logLine(`[${kind}] ${detail}`);
    });
    // render-process-gone / child-process-gone fire on `app`, not `process` — a renderer or GPU
    // crash previously left zero trace anywhere (no log entry, no Windows crash event either,
    // since Crashpad intercepts it before the OS's own crash reporting sees it).
    // On a renderer crash the recovery also reaps the now-ownerless ptys and reloads the window,
    // which restores the sessions from the persisted list (fresh ptys) instead of leaking the old ones.
    installAppCrashHandlers(app, makeCrashRecovery({
      log: (kind, detail) => logLine(`[${kind}] ${JSON.stringify(detail)}`),
      reapPtys: () => ptyHost.killAll(),
      reloadWindow: () => { if (win && !win.isDestroyed()) win.webContents.reload(); },
    }));
    // Match the installer shortcut's AppUserModelID (electron-builder sets it to
    // the appId) so Windows shows the DevDeck taskbar icon and groups windows
    // correctly. Without this the running process uses Electron's default ID and
    // the taskbar falls back to the generic Electron icon.
    if (process.platform === 'win32') app.setAppUserModelId('com.soursea.devdeck');
    const store = new Store(path.join(userData, 'state.json'));
    // Reconcile the OS login item with the saved preference (e.g. after a
    // reinstall/update the registered exe path may be stale). No-op in dev / off Windows.
    applyOpenAtLogin(store.getOpenAtLogin());
    const w = createWindow();
    win = w;
    // One-shot idle shutdown (🌙) — win32 only: shutdown.exe semantics and the cockpit itself are Windows-scoped.
    // `shutdown` is declared before setupTray so the tray's hook closures can late-bind to it —
    // the scheduler itself is constructed further below, after the tray (it needs the tray's
    // setShutdownPhase, wired via onStatus) — see the `shutdown = new ShutdownScheduler(...)` below.
    let shutdown: ShutdownScheduler | null = null;
    const tray = setupTray(w, process.platform === 'win32' ? {
      toggle: () => { if (!shutdown) return; shutdown.status().phase === 'armed' ? shutdown.disarm() : shutdown.arm(); },
      now: () => shutdown?.shutdownNow(),
      cancel: () => shutdown?.cancel(),
    } : undefined);
    let shutdownLog: ShutdownLog | null = null;
    if (process.platform === 'win32') {
      shutdownLog = new ShutdownLog(path.join(userData, 'shutdown-log.json'));
      const reportShutdownError = (msg: string): void => {
        logLine(`[shutdown] ${msg}`);
        try { if (!w.isDestroyed()) w.webContents.send('devdeck:error', msg); } catch { /* renderer gone */ }
      };
      const spawnShutdown = (args: string[]): void => {
        // args array + windowsHide; an exec error must surface, not silently strand an "issued" record.
        const p = spawn('shutdown', args, { windowsHide: true, stdio: 'ignore' });
        p.on('error', (e) => reportShutdownError(`shutdown.exe failed to spawn: ${e.message}`));
        // error never fires for a clean spawn that FAILS (e.g. a shutdown already pending, policy denial)
        // — that's a non-zero exit, and it means the countdown the user is watching will never fire.
        p.on('exit', (code) => { if (code !== null && code !== 0) reportShutdownError(`shutdown ${args[0]} exited with code ${code}`); });
      };
      shutdown = new ShutdownScheduler({
        log: shutdownLog,
        now: Date.now,
        execShutdown: (sec) => spawnShutdown(['/s', '/f', '/t', String(sec), '/c', 'DevDeck idle auto-shutdown']),
        execAbort: () => spawnShutdown(['/a']),
        transcriptMtime: () => latestTranscriptMtime(path.join(homedir(), '.claude', 'projects')),
        idleHoldMs: () => store.getShutdownIdleMinutes() * 60_000,
        onStatus: (s) => {
          tray.setShutdownPhase(s.phase);
          try { if (!w.isDestroyed()) w.webContents.send('shutdown:status', s); } catch { /* renderer gone */ }
        },
        onError: reportShutdownError,
        schedule: (fn, ms) => { setTimeout(fn, ms); },
      });
    }
    registerIpc({
      win: w,
      defaultBaseDir: path.join(app.getPath('home'), 'Documents', 'GitHub'),
      store,
      sendError: (msg) => w.webContents.send('devdeck:error', msg),
      defaultLanguage: app.getLocale().split('-')[0] || 'en',
      ptyHost,
      tray,
      shutdown,
      shutdownLog,
      bootTimeMs: () => Date.now() - uptime() * 1000,
    });
    registerUpdater(w);
    globalShortcut.register('Control+Alt+D', showWindow);
    app.on('activate', () => { if (!win) win = createWindow(); });
  });

  app.on('window-all-closed', () => { /* stay alive in tray */ });
  app.on('before-quit', () => ptyHost.killAll());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
