import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Store } from './store';
import { scanFolders, isRepo } from './scanner';
import { getGitInfo } from './gitInfo';
import { getProvider, availableAgents } from './agents';
import type { AgentId, Folder } from '../shared/types';
import { isAllowedPath } from '../shared/pathGuard';
import { buildProjectList } from './projects';
import { openProjects, openInEditor } from './launcher';
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

export function registerIpc(cfg: IpcConfig): void {
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
  }));
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

  ipcMain.handle('projects:open', (_e, items: { path: string; sessionId: string | null }[]) => {
    const now = new Date().toISOString();
    const folders = effFolders();
    const tabs: WtTab[] = [];
    for (const it of items) {
      if (!isAllowedPath(folders, it.path)) {
        cfg.sendError(`Path outside base dir: ${it.path}`);
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
      cfg.sendError(`Path outside base dir: ${p}`);
      return;
    }
    const err = await shell.openPath(p);
    if (err) cfg.sendError(err);
  });

  // Open the project in VS Code (`code <path>`).
  ipcMain.handle('project:openEditor', (_e, p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside base dir: ${p}`);
      return;
    }
    openInEditor(p, { onError: cfg.sendError });
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
