import { ipcMain, dialog, shell, app, clipboard, type BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { PtyHost } from './ptyHost';
import { applyOpenAtLogin, effectiveOpenAtLogin } from './autostart';
import { scanFolders, isRepo } from './scanner';
import { getGitInfo, getRepoUrl } from './gitInfo';
import { getProvider, availableAgents, resolveOpenSession } from './agents';
import type { AgentId, Folder } from '../shared/types';
import { isAllowedPath } from '../shared/pathGuard';
import { isAllowedExternalUrl, isSafeRepoUrl } from '../shared/externalUrl';
import { buildProjectList } from './projects';
import { createProject } from './createProject';
import { openProjects, openInEditor, resolveShellPath } from './launcher';
import type { WtTab } from '../shared/wtArgs';
import { scanUsage } from './usageScan';
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
  let lastTrayCounts = { attention: 0, turn: 0 }; // remember the latest needs-you counts so a tray-alert setting change re-applies at once
  // Legacy single-base value, retained only for the settings:get response (back-compat); not used for scanning or the security guard.
  const effBaseDir = () => cfg.store.getBaseDir() ?? cfg.defaultBaseDir;
  const effThresholds = () => cfg.store.getThresholds() ?? DEFAULT_THRESHOLDS;
  const effFolders = (): Folder[] => {
    const f = cfg.store.getFolders();
    return f.length ? f : [{ path: cfg.defaultBaseDir, kind: 'root' }];
  };

  const activeAgent = (): AgentId => {
    const a = cfg.store.getAgent();
    return a === 'codex' || a === 'claude' ? a : 'claude';
  };
  const agent = () => getProvider(activeAgent());

  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      nowMs: Date.now(),
      thresholds: effThresholds(),
      scan: () => scanFolders(effFolders()),
      git: (dir) => getGitInfo(dir),
      sessions: (p) => agent().listSessions(p),
      resumeCue: (p, sessionId) => agent().lastUserMessage(p, sessionId),
      getEntry: (p) => cfg.store.get(p),
    });
  });

  ipcMain.handle('project:setNote', (_e, path: string, note: string) => {
    cfg.store.setNote(path, String(note).slice(0, 10000));
  });
  ipcMain.handle('project:setPinned', (_e, path: string, pinned: boolean) => {
    cfg.store.setPinned(path, pinned);
  });
  ipcMain.handle('project:setHidden', (_e, path: string, hidden: boolean) => {
    cfg.store.setHidden(path, hidden);
  });

  ipcMain.handle('usage:report', async (_e, sinceMs: number) => {
    const ms = (Number.isFinite(sinceMs) || sinceMs === Infinity) ? sinceMs : 0;
    const repos = await scanFolders(effFolders());
    return scanUsage(repos, CLAUDE_PROJECTS, ms);
  });
  ipcMain.handle('settings:getLanguage', () => cfg.store.getLanguage() ?? cfg.defaultLanguage);
  ipcMain.handle('settings:setLanguage', (_e, lang: string) => cfg.store.setLanguage(lang));
  ipcMain.handle('settings:getAgent', () => activeAgent());
  ipcMain.handle('settings:availableAgents', () => availableAgents());
  ipcMain.handle('settings:setAgent', (_e, id: string) => {
    if (id === 'claude' || id === 'codex') cfg.store.setAgent(id);
  });

  ipcMain.handle('settings:get', () => ({
    baseDir: effBaseDir(), thresholds: effThresholds(), language: cfg.store.getLanguage() ?? cfg.defaultLanguage,
    openAtLogin: effectiveOpenAtLogin(cfg.store.getOpenAtLogin()), platform: process.platform,
    viewMode: cfg.store.getViewMode(), trayAlert: cfg.store.getTrayAlert(),
  }));
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
  ipcMain.handle('cockpit:open', (_e, req: { projectPath: string; sessionId: string | null; cols: number; rows: number; fresh?: boolean }) => {
    const folders = effFolders();
    if (!isAllowedPath(folders, req.projectPath)) {
      cfg.sendError(`Path outside allowed folders: ${req.projectPath}`);
      return { id: '', agentId: agent().id, sessionId: null };
    }
    const a = agent();
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
    // Guard against the window being gone (e.g. reload) when late pty output arrives.
    const send = (channel: string, payload: unknown) => { if (!cfg.win.isDestroyed()) cfg.win.webContents.send(channel, payload); };
    cfg.ptyHost.create(
      id, shellPath, ['-NoExit', '-Command', resolved.command], req.projectPath,
      Math.max(20, req.cols | 0), Math.max(5, req.rows | 0),
      (chunk) => send('cockpit:data', { id, chunk }),
      (e) => send('cockpit:exit', { id, exitCode: e.exitCode }),
    );
    cfg.store.setLastOpened(req.projectPath, new Date().toISOString());
    return { id, agentId: a.id, sessionId: resolved.sessionId };
  });
  ipcMain.on('cockpit:input', (_e, id: string, data: string) => cfg.ptyHost.write(String(id), String(data)));
  ipcMain.on('cockpit:resize', (_e, id: string, cols: number, rows: number) => cfg.ptyHost.resize(String(id), Math.max(1, cols | 0), Math.max(1, rows | 0)));
  ipcMain.on('cockpit:close', (_e, id: string) => cfg.ptyHost.kill(String(id)));

  // Cockpit session persistence: remember the open sessions so a quit/crash doesn't lose them.
  // The store sanitizes on read & write, so a corrupted state.json can't inject bad data.
  ipcMain.handle('cockpit:loadSessions', () => cfg.store.getCockpitSessions());
  ipcMain.on('cockpit:saveSessions', (_e, list: PersistedSession[]) => cfg.store.setCockpitSessions(Array.isArray(list) ? list : []));

  // Per-session model + active working time (read from the Claude session log) for the cockpit header/list.
  ipcMain.handle('cockpit:sessionMeta', (_e, projectPath: string, sessionId: string) => {
    if (agent().id !== 'claude' || typeof sessionId !== 'string' || !sessionId) return { model: null, activeMs: 0 };
    return readClaudeSessionMeta(String(projectPath), sessionId, CLAUDE_PROJECTS);
  });

  // Tray attention indicator (Discord-style): the renderer supplies the red-dotted icon once + live needs-you counts.
  ipcMain.on('tray:alertImage', (_e, dataUrl: string) => cfg.tray.setAlertImage(String(dataUrl)));
  ipcMain.on('tray:counts', (_e, counts: { attention?: number; turn?: number }) => {
    lastTrayCounts = { attention: Math.max(0, Number(counts?.attention) | 0), turn: Math.max(0, Number(counts?.turn) | 0) };
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
