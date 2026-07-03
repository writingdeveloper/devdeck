import { ipcMain, dialog, shell, app, clipboard, type BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { PtyHost } from './ptyHost';
import { PtyBatcher } from './ptyBatch';
import { applyOpenAtLogin, effectiveOpenAtLogin } from './autostart';
import { scanFolders, isRepo } from './scanner';
import { getGitInfo, getRepoUrl, getGitBranchDirty } from './gitInfo';
import { getProvider, availableAgents, resolveOpenSession } from './agents';
import type { AgentId, Folder } from '../shared/types';
import { isAllowedPath } from '../shared/pathGuard';
import { isAllowedExternalUrl, isSafeRepoUrl, isOpenableTerminalLink } from '../shared/externalUrl';
import { makeTtlCache } from '../shared/ttlCache';
import { buildProjectList } from './projects';
import { createProject } from './createProject';
import { openProjects, openInEditor, resolveShellPath } from './launcher';
import type { WtTab } from '../shared/wtArgs';
import { scanUsage } from './usageScan';
import { listClaudeProjectDirs } from './usageProjectsScan';
import { classifyUsageProjects } from '../shared/usageProjects';
import { sanitizeTodos } from '../shared/tasks';
import { getUsageWindows, readClaudeCredentials, fetchUsageApi, type CacheEntry } from './claudeUsage';
import type { PersistedSession } from '../shared/cockpitPersist';
import { readClaudeSessionMeta } from './sessionMeta';
import type { TrayController } from './tray';
import { DEFAULT_THRESHOLDS } from '../shared/staleness';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const REPO_URL = 'https://github.com/writingdeveloper/devdeck';

export interface IpcConfig {
  win: BrowserWindow;
  defaultBaseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  defaultLanguage: string;
  ptyHost: PtyHost;
  tray: TrayController;
}

export function registerIpc(cfg: IpcConfig): void {
  let lastTrayCounts = { attention: 0, turn: 0, overdue: 0 }; // remember the latest counts so a tray-alert setting change re-applies at once
  // Legacy single-base value, retained only for the settings:get response (back-compat); not used for scanning or the security guard.
  const effBaseDir = () => cfg.store.getBaseDir() ?? cfg.defaultBaseDir;
  const effThresholds = () => cfg.store.getThresholds() ?? DEFAULT_THRESHOLDS;
  const effFolders = (): Folder[] => {
    const f = cfg.store.getFolders();
    return f.length ? f : [{ path: cfg.defaultBaseDir, kind: 'root' }];
  };
  // One deck reload() calls both projects:list and usage:report; each used to run scanFolders
  // independently (double disk walk + .git probes). Share one in-flight scan for ~8s (well under the
  // ~45s auto-refresh) keyed by the folder set, so the two handlers await the same Promise.
  const scanCache = makeTtlCache<ReturnType<typeof scanFolders>>(8_000);
  const memoScan = (): ReturnType<typeof scanFolders> => {
    const folders = effFolders();
    const key = JSON.stringify(folders);
    const now = Date.now();
    const hit = scanCache.get(key, now);
    if (hit) return hit;
    const p = scanFolders(folders);
    scanCache.set(key, now, p);
    return p;
  };

  const activeAgent = (): AgentId => {
    const a = cfg.store.getAgent();
    return a === 'antigravity' || a === 'claude' ? a : 'claude';
  };
  const agent = () => getProvider(activeAgent());

  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      nowMs: Date.now(),
      thresholds: effThresholds(),
      scan: memoScan,
      git: (dir) => getGitInfo(dir),
      sessions: (p) => agent().listSessions(p),
      resumeCue: (p, sessionId) => agent().lastUserMessage(p, sessionId),
      getEntry: (p) => cfg.store.get(p),
    });
  });

  ipcMain.handle('project:setNote', (_e, path: string, note: string) => {
    cfg.store.setNote(path, String(note).slice(0, 10000));
  });
  ipcMain.handle('project:setTodos', (_e, path: string, todos: unknown) => {
    // store.setTodos sanitizes (drops junk, caps text + list length), so an untrusted array is safe.
    cfg.store.setTodos(path, sanitizeTodos(todos));
  });
  ipcMain.handle('project:setPinned', (_e, path: string, pinned: boolean) => {
    cfg.store.setPinned(path, pinned);
  });
  ipcMain.handle('project:setHidden', (_e, path: string, hidden: boolean) => {
    cfg.store.setHidden(path, hidden);
  });

  ipcMain.handle('usage:report', async (_e, sinceMs: number) => {
    const ms = (Number.isFinite(sinceMs) || sinceMs === Infinity) ? sinceMs : 0;
    const scanned = await memoScan();
    // Reconcile the live deck with ~/.claude so DELETED projects (folder gone, usage still on disk)
    // remain visible and counted in the totals — honest "where did my tokens go" accounting.
    const claudeProjects = listClaudeProjectDirs(CLAUDE_PROJECTS);
    const all = classifyUsageProjects({ scanned, claudeProjects, exists: existsSync });
    return scanUsage(all, CLAUDE_PROJECTS, ms);
  });
  ipcMain.handle('settings:getLanguage', () => cfg.store.getLanguage() ?? cfg.defaultLanguage);
  ipcMain.handle('settings:setLanguage', (_e, lang: string) => cfg.store.setLanguage(lang));
  ipcMain.handle('settings:getAgent', () => activeAgent());
  ipcMain.handle('settings:availableAgents', () => availableAgents());
  ipcMain.handle('settings:setAgent', (_e, id: string) => {
    if (id === 'claude' || id === 'antigravity') cfg.store.setAgent(id);
  });

  ipcMain.handle('settings:get', () => ({
    baseDir: effBaseDir(), thresholds: effThresholds(), language: cfg.store.getLanguage() ?? cfg.defaultLanguage,
    openAtLogin: effectiveOpenAtLogin(cfg.store.getOpenAtLogin()), platform: process.platform,
    viewMode: cfg.store.getViewMode(), trayAlert: cfg.store.getTrayAlert(), contextWindow: cfg.store.getContextWindow(),
  }));
  ipcMain.handle('settings:setContextWindow', (_e, w: number) => cfg.store.setContextWindow(w === 200_000 ? 200_000 : 1_000_000));
  ipcMain.handle('settings:setTrayAlert', (_e, mode: string) => {
    cfg.store.setTrayAlert(mode === 'off' || mode === 'all' ? mode : 'attention');
    cfg.tray.applyCounts(lastTrayCounts, cfg.store.getTrayAlert()); // re-apply immediately with the latest counts
  });
  ipcMain.handle('settings:setOpenAtLogin', (_e, enabled: boolean) => {
    const on = !!enabled;
    cfg.store.setOpenAtLogin(on);
    applyOpenAtLogin(on);
  });
  ipcMain.handle('settings:setViewMode', (_e, mode: string) => {
    cfg.store.setViewMode(mode === 'list' ? 'list' : 'cards');
  });
  ipcMain.handle('settings:setBaseDir', (_e, dir: string) => cfg.store.setBaseDir(String(dir).slice(0, 2000)));
  ipcMain.handle('settings:getFolders', () => effFolders());
  ipcMain.handle('settings:addFolder', async (_e, p: string) => {
    const path = String(p).trim().slice(0, 2000);
    let isDir = false;
    try { isDir = (await stat(path)).isDirectory(); } catch { isDir = false; }
    if (isDir) {
      const kind: Folder['kind'] = (await isRepo(path)) ? 'repo' : 'root';
      cfg.store.addFolder({ path, kind });
    }
    return effFolders();
  });
  ipcMain.handle('settings:removeFolder', (_e, p: string) => {
    cfg.store.removeFolder(String(p).slice(0, 2000));
    return effFolders();
  });
  ipcMain.handle('settings:setThresholds', (_e, t: { freshDays: number; warnDays: number; neglectedDays: number }) => {
    const { freshDays, warnDays, neglectedDays } = t ?? {};
    if (
      typeof freshDays === 'number' && typeof warnDays === 'number' && typeof neglectedDays === 'number' &&
      freshDays > 0 && freshDays <= warnDays && warnDays <= neglectedDays
    ) {
      cfg.store.setThresholds({ freshDays, warnDays, neglectedDays });
    }
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    repoUrl: REPO_URL,
    packaged: app.isPackaged,
  }));
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    const u = String(url);
    if (isAllowedExternalUrl(u)) await shell.openExternal(u);
    else cfg.sendError(`Blocked external URL: ${u}`);
  });

  ipcMain.handle('projects:open', (_e, items: { path: string; sessionId: string | null }[]) => {
    const now = new Date().toISOString();
    const folders = effFolders();
    const tabs: WtTab[] = [];
    for (const it of items) {
      if (!isAllowedPath(folders, it.path)) {
        cfg.sendError(`Path outside allowed folders: ${it.path}`);
        continue;
      }
      const a = agent();
      let command: string;
      if (typeof it.sessionId === 'string') command = a.buildCommand('resume', it.sessionId);
      else if (a.listSessions(it.path).length > 0) command = a.buildCommand('continue');
      else command = a.buildCommand('new');
      tabs.push({
        name: it.path.split(/[\\/]/).pop() ?? it.path,
        dir: it.path,
        command,
      });
      // Record lastOpened only for accepted (validated) projects.
      cfg.store.setLastOpened(it.path, now);
    }
    openProjects(tabs, { onError: cfg.sendError });
  });

  // Open the project folder in the OS file manager.
  ipcMain.handle('project:openFolder', async (_e, p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    const err = await shell.openPath(p);
    if (err) cfg.sendError(err);
  });

  // Open the project in VS Code (`code <path>`).
  ipcMain.handle('project:openEditor', (_e, p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    openInEditor(p, { onError: cfg.sendError });
  });

  // Create a new project folder under an allowed scan root and `git init` it
  // (git init is what lets the scanner discover the new folder).
  ipcMain.handle('project:create', (_e, parent: string, name: string) => {
    return createProject(effFolders(), String(parent), String(name));
  });

  // Open the project's GitHub page. The renderer passes only the path (never a URL);
  // main re-reads the repo URL from git and validates it, so a compromised renderer
  // can't open an arbitrary external URL.
  ipcMain.handle('project:openRepo', async (_e, p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    const url = await getRepoUrl(p);
    if (url && isSafeRepoUrl(url)) await shell.openExternal(url);
    else cfg.sendError(`No GitHub remote found for: ${p}`);
  });

  // Embedded cockpit: open a pty session running the agent; output streams to the renderer's xterm.
  let cockpitSeq = 0;
  // Guard against the window being gone (e.g. reload) when late pty output arrives.
  const sendToWin = (channel: string, payload: unknown): void => {
    // webContents.send can throw if the renderer is torn down mid-send (reload/quit). The global
    // error trap is the backstop, but isolating here stops a stray send from unwinding a pty
    // data/exit callback — which would otherwise escape as an uncaughtException.
    try { if (!cfg.win.isDestroyed()) cfg.win.webContents.send(channel, payload); } catch { /* renderer gone */ }
  };
  // Coalesce pty output (~one frame) before it crosses IPC so many streaming sessions don't flood the
  // renderer's single UI thread; input is never batched, and a big burst flushes immediately via the cap.
  const ptyBatch = new PtyBatcher((id, chunk) => sendToWin('cockpit:data', { id, chunk }), (flush) => { setTimeout(flush, 16); });
  ipcMain.handle('cockpit:open', (_e, req: { projectPath: string; sessionId: string | null; cols: number; rows: number; fresh?: boolean }) => {
    const folders = effFolders();
    if (!isAllowedPath(folders, req.projectPath)) {
      cfg.sendError(`Path outside allowed folders: ${req.projectPath}`);
      return { id: '', agentId: agent().id, sessionId: null };
    }
    const a = agent();
    // A failed open must come back as the same refusal shape the allowlist path returns (id: '') —
    // node-pty's spawn throws synchronously (e.g. the project folder was deleted since the session
    // was saved), and an unguarded throw here rejects the invoke, leaking the renderer's
    // already-mounted terminal and aborting a restore-all loop mid-way.
    try {
      // Resolve BOTH the launch command and the concrete session id to persist (so each session
      // restores to its OWN conversation — required once a project can hold several sessions).
      const resolved = resolveOpenSession(a, {
        fresh: !!req.fresh,
        sessionId: req.sessionId,
        sessionCount: req.fresh ? 1 : a.listSessions(req.projectPath).length, // count only consulted on the non-fresh new/continue path
        latestId: a.listSessions(req.projectPath, 1)[0]?.id ?? null,
        genId: () => randomUUID(),
      });
      const shellPath = resolveShellPath();
      const id = `${req.projectPath}#${++cockpitSeq}`;
      cfg.ptyHost.create(
        id, shellPath, ['-NoExit', '-Command', resolved.command], req.projectPath,
        Math.max(20, req.cols | 0), Math.max(5, req.rows | 0),
        (chunk) => ptyBatch.push(id, chunk),
        (e) => { ptyBatch.flush(); sendToWin('cockpit:exit', { id, exitCode: e.exitCode }); }, // flush buffered output before the exit notice
      );
      cfg.store.setLastOpened(req.projectPath, new Date().toISOString());
      return { id, agentId: a.id, sessionId: resolved.sessionId };
    } catch (err) {
      cfg.sendError(`Could not open session in ${req.projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      return { id: '', agentId: a.id, sessionId: null };
    }
  });
  ipcMain.on('cockpit:input', (_e, id: string, data: string) => cfg.ptyHost.write(String(id), String(data)));
  ipcMain.on('cockpit:resize', (_e, id: string, cols: number, rows: number) => cfg.ptyHost.resize(String(id), Math.max(1, cols | 0), Math.max(1, rows | 0)));
  ipcMain.on('cockpit:close', (_e, id: string) => { ptyBatch.drop(String(id)); cfg.ptyHost.kill(String(id)); });

  // Cockpit session persistence: remember the open sessions so a quit/crash doesn't lose them.
  // The store sanitizes on read & write, so a corrupted state.json can't inject bad data.
  ipcMain.handle('cockpit:loadSessions', () => cfg.store.getCockpitSessions());
  ipcMain.on('cockpit:saveSessions', (_e, list: PersistedSession[]) => cfg.store.setCockpitSessions(Array.isArray(list) ? list : []));

  // Seamless update: the renderer records the live sessions right before quitAndInstall; the next
  // launch consumes (reads + clears) them to auto-restore. store.* sanitize, so untrusted input is safe.
  ipcMain.handle('update:setPendingAutoRestore', (_e, list: PersistedSession[]) => cfg.store.setPendingAutoRestore(Array.isArray(list) ? list : []));
  ipcMain.handle('update:consumeAutoRestore', () => cfg.store.consumePendingAutoRestore());

  // Per-session model + active working time (read from the Claude session log) for the cockpit header/list.
  ipcMain.handle('cockpit:sessionMeta', (_e, projectPath: string, sessionId: string) => {
    if (agent().id !== 'claude' || typeof sessionId !== 'string' || !sessionId) return { model: null, activeMs: 0, contextTokens: 0 };
    return readClaudeSessionMeta(String(projectPath), sessionId, CLAUDE_PROJECTS);
  });
  // Newest-first session ids for a project (mtime-desc) — restore resumes the LATEST conversation,
  // not a frozen pinned id that has since gone stale.
  ipcMain.handle('cockpit:sessionIds', (_e, projectPath: string) => agent().listSessions(String(projectPath)).map((s) => s.id));

  // Live git branch + dirty count for a cockpit session's project. Re-read on a slow tick so a
  // RESTORED session (re-created with no branch) and in-terminal branch switches both show the real
  // branch instead of a stale snapshot or "-". Uses the 2-call branch+dirty reader (not the deck's
  // 5-call getGitInfo) since the cockpit refreshes this per session.
  ipcMain.handle('cockpit:gitInfo', (_e, projectPath: string) => {
    // Same allowlist as every other path-taking handler — a compromised renderer must not be able
    // to point git at arbitrary filesystem locations.
    if (!isAllowedPath(effFolders(), String(projectPath))) return null;
    return getGitBranchDirty(String(projectPath));
  });

  // Tray attention indicator (Discord-style): the renderer supplies the red-dotted icon once + live needs-you counts.
  ipcMain.on('tray:alertImage', (_e, dataUrl: string) => cfg.tray.setAlertImage(String(dataUrl)));
  // Partial merge: the cockpit sends {attention, turn} and the deck sends {overdue} independently —
  // each sender updates only the fields it owns, so one can't zero the other's counts.
  ipcMain.on('tray:counts', (_e, counts: { attention?: number; turn?: number; overdue?: number }) => {
    const norm = (v: unknown): number => Math.max(0, Number(v) | 0);
    lastTrayCounts = {
      attention: counts?.attention === undefined ? lastTrayCounts.attention : norm(counts.attention),
      turn: counts?.turn === undefined ? lastTrayCounts.turn : norm(counts.turn),
      overdue: counts?.overdue === undefined ? lastTrayCounts.overdue : norm(counts.overdue),
    };
    cfg.tray.applyCounts(lastTrayCounts, cfg.store.getTrayAlert());
  });

  // Opt-in usage monitor. Token is read + used ONLY in the main process (claudeUsage);
  // only computed percentages/plan/reset cross IPC.
  const usageCachePath = () => join(app.getPath('userData'), 'usage-cache.json');
  ipcMain.handle('usage:windows', async () => {
    // Always-on: the bar self-hides when there are no Claude credentials (no network call made in that case).
    return getUsageWindows({
      now: () => Date.now(),
      env: process.env,
      readCredentials: () => readClaudeCredentials(),
      fetchUsage: (token) => fetchUsageApi(token),
      cacheRead: () => {
        // Validate shape so an externally-corrupted cache file can't yield {data: undefined} (which would crash the renderer).
        try {
          const c = JSON.parse(readFileSync(usageCachePath(), 'utf8'));
          return (c && typeof c.timestamp === 'number' && c.data && typeof c.data === 'object') ? (c as CacheEntry) : null;
        } catch { return null; }
      },
      cacheWrite: (e) => { try { writeFileSync(usageCachePath(), JSON.stringify(e), 'utf8'); } catch { /* ignore */ } },
    });
  });

  // Clipboard bridge for the embedded terminal (the sandboxed file:// renderer can't reach
  // navigator.clipboard reliably). Used so Ctrl+C copies a selection instead of sending SIGINT.
  ipcMain.on('clipboard:writeText', (_e, text: string) => clipboard.writeText(String(text ?? '')));
  ipcMain.handle('clipboard:readText', () => clipboard.readText());

  // Open a clicked terminal link. Terminal output is arbitrary, so (unlike shell:openExternal, which is
  // locked to DevDeck's own repo) any host is allowed — but only the http/https scheme, never file:/etc.
  ipcMain.handle('cockpit:openLink', async (_e, url: string) => {
    const u = String(url);
    if (isOpenableTerminalLink(u)) await shell.openExternal(u);
    else cfg.sendError(`Blocked terminal link: ${u}`);
  });

  // Frameless-window controls (the title bar draws its own buttons).
  ipcMain.handle('win:minimize', () => cfg.win.minimize());
  ipcMain.handle('win:toggleMaximize', () => {
    cfg.win.isMaximized() ? cfg.win.unmaximize() : cfg.win.maximize();
  });
  ipcMain.handle('win:close', () => cfg.win.close());
  ipcMain.handle('win:isMaximized', () => cfg.win.isMaximized());
  cfg.win.on('maximize', () => cfg.win.webContents.send('win:maximize-changed', true));
  cfg.win.on('unmaximize', () => cfg.win.webContents.send('win:maximize-changed', false));
}
