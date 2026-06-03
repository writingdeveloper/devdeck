import { ipcMain, dialog } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store';
import { scanRepos } from './scanner';
import { getGitInfo } from './gitInfo';
import { listSessions } from './sessions';
import { buildProjectList } from './projects';
import { openProjects, resolveShell, resolveWtPath } from './launcher';
import type { WtTab } from '../shared/wtArgs';
import { scanUsage } from './usageScan';
import { DEFAULT_THRESHOLDS } from '../shared/staleness';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

export interface IpcConfig {
  defaultBaseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  selfName: string;
  defaultLanguage: string;
}

export function registerIpc(cfg: IpcConfig): void {
  const effBaseDir = () => cfg.store.getBaseDir() ?? cfg.defaultBaseDir;
  const effThresholds = () => cfg.store.getThresholds() ?? DEFAULT_THRESHOLDS;

  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      baseDir: effBaseDir(),
      nowMs: Date.now(),
      thresholds: effThresholds(),
      scan: (base) => scanRepos(base).filter((r) => r.name !== cfg.selfName),
      git: (dir) => getGitInfo(dir),
      sessions: (p) => listSessions(p, CLAUDE_PROJECTS),
      getEntry: (p) => cfg.store.get(p),
    });
  });

  ipcMain.handle('project:setNote', (_e, path: string, note: string) => {
    cfg.store.setNote(path, note);
  });
  ipcMain.handle('project:setPinned', (_e, path: string, pinned: boolean) => {
    cfg.store.setPinned(path, pinned);
  });
  ipcMain.handle('project:setHidden', (_e, path: string, hidden: boolean) => {
    cfg.store.setHidden(path, hidden);
  });

  ipcMain.handle('usage:report', (_e, sinceMs: number) => {
    const repos = scanRepos(effBaseDir()).filter((r) => r.name !== cfg.selfName);
    return scanUsage(repos, CLAUDE_PROJECTS, sinceMs);
  });
  ipcMain.handle('settings:getLanguage', () => cfg.store.getLanguage() ?? cfg.defaultLanguage);
  ipcMain.handle('settings:setLanguage', (_e, lang: string) => cfg.store.setLanguage(lang));

  ipcMain.handle('settings:get', () => ({
    baseDir: effBaseDir(), thresholds: effThresholds(), language: cfg.store.getLanguage() ?? cfg.defaultLanguage,
  }));
  ipcMain.handle('settings:setBaseDir', (_e, dir: string) => cfg.store.setBaseDir(dir));
  ipcMain.handle('settings:setThresholds', (_e, t: { freshDays: number; warnDays: number; neglectedDays: number }) => cfg.store.setThresholds(t));
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle('projects:open', (_e, items: { path: string; sessionId: string | null }[]) => {
    const shell = resolveShell();
    const tabs: WtTab[] = items.map((it) => ({
      name: it.path.split('\\').pop() ?? it.path,
      dir: it.path,
      command: it.sessionId ? `claude -r ${it.sessionId}` : 'claude',
    }));
    const now = new Date().toISOString();
    for (const it of items) cfg.store.setLastOpened(it.path, now);
    openProjects(tabs, { wtPath: resolveWtPath(), shell, onError: cfg.sendError });
  });
}
