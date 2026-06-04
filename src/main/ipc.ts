import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Store } from './store';
import { scanRepos } from './scanner';
import { getGitInfo } from './gitInfo';
import { listSessions, isValidSessionId, lastUserMessageForSession } from './sessions';
import { buildProjectList } from './projects';
import { openProjects } from './launcher';
import type { WtTab } from '../shared/wtArgs';
import { scanUsage } from './usageScan';
import { DEFAULT_THRESHOLDS } from '../shared/staleness';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

export interface IpcConfig {
  win: BrowserWindow;
  defaultBaseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  defaultLanguage: string;
}

function isUnderBase(base: string, incoming: string): boolean {
  const r = resolve(incoming);
  const b = resolve(base);
  return r === b || r.startsWith(b + sep);
}

export function registerIpc(cfg: IpcConfig): void {
  const effBaseDir = () => cfg.store.getBaseDir() ?? cfg.defaultBaseDir;
  const effThresholds = () => cfg.store.getThresholds() ?? DEFAULT_THRESHOLDS;

  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      baseDir: effBaseDir(),
      nowMs: Date.now(),
      thresholds: effThresholds(),
      scan: (base) => scanRepos(base),
      git: (dir) => getGitInfo(dir),
      sessions: (p) => listSessions(p, CLAUDE_PROJECTS),
      resumeCue: (p, sessionId) => lastUserMessageForSession(p, sessionId, CLAUDE_PROJECTS),
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
    const repos = await scanRepos(effBaseDir());
    return scanUsage(repos, CLAUDE_PROJECTS, ms);
  });
  ipcMain.handle('settings:getLanguage', () => cfg.store.getLanguage() ?? cfg.defaultLanguage);
  ipcMain.handle('settings:setLanguage', (_e, lang: string) => cfg.store.setLanguage(lang));

  ipcMain.handle('settings:get', () => ({
    baseDir: effBaseDir(), thresholds: effThresholds(), language: cfg.store.getLanguage() ?? cfg.defaultLanguage,
  }));
  ipcMain.handle('settings:setBaseDir', (_e, dir: string) => cfg.store.setBaseDir(String(dir).slice(0, 2000)));
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

  ipcMain.handle('projects:open', (_e, items: { path: string; sessionId: string | null }[]) => {
    const base = effBaseDir();
    const now = new Date().toISOString();
    const tabs: WtTab[] = [];
    for (const it of items) {
      if (!isUnderBase(base, it.path)) {
        cfg.sendError(`Path outside base dir: ${it.path}`);
        continue;
      }
      let command: string;
      // Only interpolate a session id into the shell command if it is a valid
      // (UUID-ish) id; otherwise fall back to continue/new so a crafted id cannot
      // inject into `claude -r <id>` at this trust boundary.
      if (typeof it.sessionId === 'string' && isValidSessionId(it.sessionId)) {
        command = `claude -r ${it.sessionId}`;
      } else if (listSessions(it.path, CLAUDE_PROJECTS).length > 0) {
        command = 'claude -c';
      } else {
        command = 'claude';
      }
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
    if (!isUnderBase(effBaseDir(), p)) {
      cfg.sendError(`Path outside base dir: ${p}`);
      return;
    }
    const err = await shell.openPath(p);
    if (err) cfg.sendError(err);
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
