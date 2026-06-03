import { ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store';
import { scanRepos } from './scanner';
import { getGitInfo } from './gitInfo';
import { getLastSessionMs } from './sessionInfo';
import { buildProjectList } from './projects';
import { openProjects, resolveShell, resolveWtPath } from './launcher';
import type { WtTab } from '../shared/wtArgs';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

export interface IpcConfig {
  baseDir: string;
  store: Store;
}

export function registerIpc(cfg: IpcConfig): void {
  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      baseDir: cfg.baseDir,
      nowMs: Date.now(),
      scan: scanRepos,
      git: (dir) => getGitInfo(dir),
      session: (p) => getLastSessionMs(p, CLAUDE_PROJECTS),
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

  ipcMain.handle('projects:open', (_e, paths: string[]) => {
    const shell = resolveShell();
    const tabs: WtTab[] = paths.map((p) => ({
      name: p.split('\\').pop() ?? p,
      dir: p,
      command: 'claude -c',
    }));
    const now = new Date().toISOString();
    for (const p of paths) cfg.store.setLastOpened(p, now);
    openProjects(tabs, { wtPath: resolveWtPath(), shell });
  });
}
