import { ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store';
import { scanRepos } from './scanner';
import { getGitInfo } from './gitInfo';
import { listSessions } from './sessions';
import { buildProjectList } from './projects';
import { openProjects, resolveShell, resolveWtPath } from './launcher';
import type { WtTab } from '../shared/wtArgs';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

export interface IpcConfig {
  baseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  selfName: string;
}

export function registerIpc(cfg: IpcConfig): void {
  ipcMain.handle('projects:list', async () => {
    return buildProjectList({
      baseDir: cfg.baseDir,
      nowMs: Date.now(),
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
