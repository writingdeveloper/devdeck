import { app, BrowserWindow, globalShortcut, crashReporter, powerMonitor, powerSaveBlocker, safeStorage, screen } from 'electron';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { uptime, homedir, tmpdir } from 'node:os';
import { Store } from './store';
import { registerIpc } from './ipc';
import { PtyHost, type PtySpawn } from './ptyHost';
import { setupTray } from './tray';
import { registerUpdater } from './updater';
import { applyOpenAtLogin } from './autostart';
import { installGlobalErrorHandlers, installAppCrashHandlers, makeCrashRecovery } from './errorGuard';
import { DiagnosticsLog, adoptLegacyErrorLog } from './diagnostics';
import { ShutdownLog } from './shutdownLog';
import { ShutdownScheduler } from './shutdownScheduler';
import { latestTranscriptMtime } from './transcriptFreshness';
import { cleanupPasteImages } from './tempClean';
import { resolveWindowBounds, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '../shared/windowBounds';
import { createLinkService, type LinkService } from './link/linkService';
import { withTimeout } from '../shared/withTimeout';

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

/** Event channels a paired machine's pushes are allowed to reach this window on. */
const REMOTE_EVENT_CHANNELS = new Set(['cockpit:data', 'cockpit:exit', 'cockpit:resized', 'link:sessions', 'link:error']);
// Module-scoped so the quit handler can shut the link down; assigned once the app is ready.
let linkService: LinkService | null = null;

function createWindow(store: Store): BrowserWindow {
  // Reopen where the user left it. Falls back to a size chosen to hold the sidebar, a full project
  // row and a terminal at once — the old 1000x720 default arrived already clipping its own content.
  const bounds = resolveWindowBounds(store.getWindowBounds(), screen.getAllDisplays().map((d) => d.workArea));
  const w = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    frame: false,
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (bounds.maximized) w.maximize();
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // Persist on settle, not on every frame of a drag: resize/move fire continuously, and state.json is
  // rewritten in full on each save. The un-maximized rectangle is what gets stored, so un-maximizing
  // later returns to the size the user actually picked rather than to a full-screen one.
  let saveTimer: NodeJS.Timeout | null = null;
  const rememberBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized()) return;
      store.setWindowBounds({ ...w.getNormalBounds(), maximized: w.isMaximized() });
    }, 400);
  };
  w.on('resize', rememberBounds); w.on('move', rememberBounds);
  w.on('maximize', rememberBounds); w.on('unmaximize', rememberBounds);
  // A close can beat the debounce, so take the final reading synchronously.
  w.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (!w.isMinimized()) store.setWindowBounds({ ...w.getNormalBounds(), maximized: w.isMaximized() });
  });
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
    // One log per machine, for the person (or the agent) sitting at it. The crash-only predecessor
    // recorded nothing about a machine that was misbehaving without dying, which is most of them.
    const diagnostics = new DiagnosticsLog(path.join(userData, 'devdeck.log'), {
      echo: (line) => console.error('DevDeck', line),
    });
    adoptLegacyErrorLog(diagnostics, path.join(userData, 'devdeck-errors.log'));
    const logLine = (line: string): void => diagnostics.write('error', 'main', line);
    diagnostics.write('info', 'app', `started v${app.getVersion()} electron=${process.versions.electron} platform=${process.platform} ${process.arch}`);
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
    // Sweep stale clipboard-paste temp PNGs (best-effort, async, off the startup critical path).
    // Also on a slow interval: DevDeck is a tray app that can run for weeks, so a startup-only
    // sweep would never fire for exactly the long-lived sessions that accumulate the most pastes.
    const sweepPasteImages = (): void => { void cleanupPasteImages(tmpdir(), Date.now()); };
    sweepPasteImages();
    setInterval(sweepPasteImages, 6 * 3_600_000);
    const store = new Store(path.join(userData, 'state.json'));
    // Reconcile the OS login item with the saved preference (e.g. after a
    // reinstall/update the registered exe path may be stale). No-op in dev / off Windows.
    applyOpenAtLogin(store.getOpenAtLogin());
    const w = createWindow(store);
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
    // Declared before registerIpc so the API table's `link:*` methods can late-bind to it: building
    // the link needs the table, so the table cannot be handed a finished link.
    let link: LinkService | null = null;
    const deckApi = registerIpc({
      win: w,
      defaultBaseDir: path.join(app.getPath('home'), 'Documents', 'GitHub'),
      store,
      sendError: (msg) => w.webContents.send('devdeck:error', msg),
      defaultLanguage: app.getLocale().split('-')[0] || 'en',
      ptyHost,
      ptyAvailable: nodePty !== null,
      tray,
      shutdown,
      shutdownLog,
      bootTimeMs: () => Date.now() - uptime() * 1000,
      link: () => link,
      diagnostics,
    });

    // The method table, reachable from a harness driving the unpackaged app (qa/*.mjs): it lets a
    // check freeze one answer — the project list, say — and then hand the channel BACK to the real
    // handler, which ipcMain alone cannot do once a handler has been replaced. Never in a package.
    if (!app.isPackaged) (globalThis as { __devdeckApi?: unknown }).__devdeckApi = deckApi;

    // DevDeck Link. Accepting connections stays off until someone turns it on; constructing the
    // service only loads this machine's identity and reconnects to machines already paired with.
    const toRenderer = (channel: string, payload: unknown): void => {
      try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch { /* renderer gone */ }
    };
    link = createLinkService({
      userDataDir: userData,
      safeStorage,
      api: deckApi,
      machineId: store.getMachineId(),
      machineName: () => store.getMachineName(),
      appVersion: app.getVersion(),
      store: {
        getHostMode: () => store.getLinkHostMode(),
        setHostMode: (on) => store.setLinkHostMode(on),
        getPort: () => store.getLinkPort(),
        setPort: (port) => store.setLinkPort(port),
        getPairedDevices: () => store.getPairedDevices(),
        setPairedDevices: (devices) => store.setPairedDevices(devices),
        getKnownHosts: () => store.getKnownHosts(),
        setKnownHosts: (hosts) => store.setKnownHosts(hosts),
      },
      onError: (message) => { logLine(`[link] ${message}`); toRenderer('devdeck:error', message); },
      onChanged: () => toRenderer('link:changed', null),
      // Remote output goes STRAIGHT to this window rather than through the API's event hub. The hub
      // is this machine's own output, and republishing another machine's bytes into it would offer
      // them onward to anyone viewing THIS machine.
      // And only the channels a host is expected to push. Anything else arriving as an event —
      // `devdeck:error`, `devdeck:update`, `shutdown:status` — would land on the renderer under that
      // name as if this machine had produced it.
      onRemoteEvent: (channel, payload) => { if (REMOTE_EVENT_CHANNELS.has(channel)) toRenderer(channel, payload); },
      onRemotePty: (id, bytes) => toRenderer('cockpit:data', { id, chunk: bytes.toString('utf8') }),
      onRemoteActivity: () => shutdown?.noteBusy(),
      // What a paired machine may name: the sessions this machine announces, and nothing it does not.
      liveSessionIds: () => ptyHost.list().map((s) => s.id),
    });
    linkService = link;

    // Someone working here from another machine must not have this one power down or sleep under
    // them. The idle watcher only counts local activity, and remote keystrokes never touch this
    // machine's input devices — so while a viewer is attached, keep saying it is busy.
    let sleepBlocker: number | null = null;
    setInterval(() => {
      const watched = link?.hasRemoteViewers() === true;
      if (watched) shutdown?.noteBusy();
      if (watched && sleepBlocker === null) {
        sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
      } else if (!watched && sleepBlocker !== null) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = null;
      }
    }, 30_000);

    // A machine that was ASLEEP was not idle.
    //
    // The idle watcher measures idleness as wall-clock time since the last busy signal, and nothing
    // signals while the process is suspended — so a laptop left armed at midnight and opened at eight
    // wakes to `now - lastBusyAt` of eight hours and issues `shutdown /s /f /t 60` on its very first
    // tick, before the user has touched anything. Reproduced against the real scheduler: one suspend,
    // one tick, straight to countdown. Resuming is itself the proof that those hours were sleep.
    //
    // The renderer is told too: everything time-based over there was measured against a clock that
    // jumped, and the usage read in particular is both stale and was taken while the network was down.
    powerMonitor.on('resume', () => {
      shutdown?.noteBusy();
      toRenderer('devdeck:resume', null);
      // Every link this machine held across the sleep may be a socket whose other end is long gone.
      // Ask now, rather than letting a tile that looks connected stay silent until the heartbeat
      // gives up on it.
      link?.probe();
    });
    // And going INTO sleep, say goodbye: peers learn it in one round trip instead of a timeout, and
    // the sessions viewers held here are released before anything asks whether someone is watching.
    powerMonitor.on('suspend', () => { link?.suspend(); });

    registerUpdater(w);
    globalShortcut.register('Control+Alt+D', showWindow);
    app.on('activate', () => { if (!win) win = createWindow(store); });
  });

  app.on('window-all-closed', () => { /* stay alive in tray */ });
  let quitReady = false;
  let quitWork: Promise<void> | null = null;
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitWork) return; // repeated Quit cannot bypass or duplicate native cleanup
    (app as typeof app & { isQuitting?: boolean }).isQuitting = true;
    quitWork = Promise.allSettled([
      ptyHost.shutdown(),
      withTimeout(Promise.resolve(linkService?.dispose()), 5_000, 'link shutdown'),
    ]).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.error('DevDeck: shutdown incomplete', result.reason);
      // Exit promises can settle inside a native terminal callback. Let that callback unwind before
      // Electron tears down its Node environment; quitting in its microtask can stall native teardown.
      setImmediate(() => { quitReady = true; app.quit(); });
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
