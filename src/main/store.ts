import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreEntry, Folder } from '../shared/types';
import { sanitizePersistedList, type PersistedSession } from '../shared/cockpitPersist';
import { sanitizeTodos, type Todo } from '../shared/tasks';

interface StateFile {
  projects: Record<string, StoreEntry>;
  settings?: { language?: string; baseDir?: string; folders?: Folder[]; thresholds?: { freshDays: number; warnDays: number; neglectedDays: number }; agent?: string; openAtLogin?: boolean; viewMode?: 'cards' | 'list'; cockpitSessions?: PersistedSession[]; trayAlert?: 'off' | 'attention' | 'all'; pendingAutoRestore?: PersistedSession[]; contextWindow?: number };
}

const EMPTY: StoreEntry = {
  note: '', pinned: false, hidden: false, lastOpened: null, todos: [],
};

export class Store {
  private state: StateFile;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  private load(): StateFile {
    if (!existsSync(this.filePath)) return { projects: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return { projects: parsed.projects ?? {}, settings: parsed.settings };
    } catch {
      return { projects: {} };
    }
  }

  private save(): void {
    const tmp = this.filePath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('DevDeck: failed to persist state', err);
    }
  }

  get(path: string): StoreEntry {
    const e = { ...EMPTY, ...this.state.projects[path] };
    return { ...e, todos: sanitizeTodos(e.todos) }; // never hand out unvalidated on-disk todos
  }

  private mutate(path: string, patch: Partial<StoreEntry>): void {
    this.state.projects[path] = { ...this.get(path), ...patch };
    this.save();
  }

  getLanguage(): string | null {
    return this.state.settings?.language ?? null;
  }
  setLanguage(language: string): void {
    this.state.settings = { ...(this.state.settings ?? {}), language };
    this.save();
  }

  getBaseDir(): string | null { return this.state.settings?.baseDir ?? null; }
  setBaseDir(baseDir: string): void { this.state.settings = { ...(this.state.settings ?? {}), baseDir }; this.save(); }

  getFolders(): Folder[] {
    const f = this.state.settings?.folders;
    if (f !== undefined) return [...f];
    const b = this.state.settings?.baseDir;
    return b ? [{ path: b, kind: 'root' }] : [];
  }
  addFolder(folder: Folder): void {
    const cur = this.state.settings?.folders ?? this.getFolders();
    const exists = cur.some((x) => resolve(x.path) === resolve(folder.path));
    const folders = exists ? cur : [...cur, folder];
    this.state.settings = { ...(this.state.settings ?? {}), folders };
    this.save();
  }
  removeFolder(path: string): void {
    const cur = this.state.settings?.folders ?? this.getFolders();
    const folders = cur.filter((x) => resolve(x.path) !== resolve(path));
    this.state.settings = { ...(this.state.settings ?? {}), folders };
    this.save();
  }

  getThresholds(): { freshDays: number; warnDays: number; neglectedDays: number } | null { return this.state.settings?.thresholds ?? null; }
  setThresholds(thresholds: { freshDays: number; warnDays: number; neglectedDays: number }): void { this.state.settings = { ...(this.state.settings ?? {}), thresholds }; this.save(); }

  getAgent(): string | null { return this.state.settings?.agent ?? null; }
  setAgent(agent: string): void { this.state.settings = { ...(this.state.settings ?? {}), agent }; this.save(); }

  getOpenAtLogin(): boolean { return this.state.settings?.openAtLogin ?? false; }
  setOpenAtLogin(openAtLogin: boolean): void { this.state.settings = { ...(this.state.settings ?? {}), openAtLogin }; this.save(); }

  getViewMode(): 'cards' | 'list' { return this.state.settings?.viewMode === 'list' ? 'list' : 'cards'; }
  setViewMode(viewMode: 'cards' | 'list'): void { this.state.settings = { ...(this.state.settings ?? {}), viewMode }; this.save(); }

  getCockpitSessions(): PersistedSession[] { return sanitizePersistedList(this.state.settings?.cockpitSessions); }
  setCockpitSessions(list: PersistedSession[]): void { this.state.settings = { ...(this.state.settings ?? {}), cockpitSessions: sanitizePersistedList(list) }; this.save(); }

  // The cockpit sessions that were LIVE when the user restarted for an update — auto-restored once on
  // the next launch (its presence is the "restarted for update" signal), then consumed/cleared.
  getPendingAutoRestore(): PersistedSession[] { return sanitizePersistedList(this.state.settings?.pendingAutoRestore); }
  setPendingAutoRestore(list: PersistedSession[]): void { this.state.settings = { ...(this.state.settings ?? {}), pendingAutoRestore: sanitizePersistedList(list) }; this.save(); }
  consumePendingAutoRestore(): PersistedSession[] { const l = this.getPendingAutoRestore(); this.setPendingAutoRestore([]); return l; }

  // Context window (tokens) for the cockpit's per-session context % — 1M (Claude's beta) or the 200k default.
  getContextWindow(): number { return this.state.settings?.contextWindow === 200_000 ? 200_000 : 1_000_000; }
  setContextWindow(w: number): void { this.state.settings = { ...(this.state.settings ?? {}), contextWindow: w === 200_000 ? 200_000 : 1_000_000 }; this.save(); }

  getTrayAlert(): 'off' | 'attention' | 'all' { const t = this.state.settings?.trayAlert; return t === 'off' || t === 'all' ? t : 'attention'; }
  setTrayAlert(t: 'off' | 'attention' | 'all'): void { this.state.settings = { ...(this.state.settings ?? {}), trayAlert: t === 'off' || t === 'all' ? t : 'attention' }; this.save(); }


  setNote(path: string, note: string): void { this.mutate(path, { note }); }
  getTodos(path: string): Todo[] { return this.get(path).todos; }
  setTodos(path: string, todos: Todo[]): void { this.mutate(path, { todos: sanitizeTodos(todos) }); }
  setPinned(path: string, pinned: boolean): void { this.mutate(path, { pinned }); }
  setHidden(path: string, hidden: boolean): void { this.mutate(path, { hidden }); }
  setLastOpened(path: string, iso: string): void { this.mutate(path, { lastOpened: iso }); }
}
