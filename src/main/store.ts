import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreEntry, Folder } from '../shared/types';
import { sanitizePersistedList, type PersistedSession } from '../shared/cockpitPersist';
import { sanitizeTodos, type Todo } from '../shared/tasks';

interface StateFile {
  projects: Record<string, StoreEntry>;
  settings?: { language?: string; baseDir?: string; folders?: Folder[]; thresholds?: { freshDays: number; warnDays: number; neglectedDays: number }; agent?: string; openAtLogin?: boolean; viewMode?: 'cards' | 'list'; cockpitSessions?: PersistedSession[]; trayAlert?: 'off' | 'attention' | 'all'; pendingAutoRestore?: PersistedSession[]; contextWindow?: number; shutdownIdleMinutes?: number };
}

const EMPTY: StoreEntry = {
  note: '', pinned: false, hidden: false, lastOpened: null, todos: [],
};

export class Store {
  private state: StateFile;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  /** Parse a state file, or null if missing/unreadable/not an object (so callers can fall back). */
  private readValid(path: string): StateFile | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const projects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
      return { projects, settings: parsed.settings };
    } catch {
      return null;
    }
  }

  /**
   * Load the state, defending the user's data against a corrupt file: the live file wins, else the
   * last-good `.bak` (save() mirrors it). If the live file EXISTS but is unreadable, copy it to
   * `.corrupt` first — otherwise the next save() would atomically overwrite a recoverable file with
   * an empty one and silently wipe every note / todo / cockpit session / folder.
   */
  private load(): StateFile {
    const primary = this.readValid(this.filePath);
    if (primary) return primary;
    if (existsSync(this.filePath)) {
      try { copyFileSync(this.filePath, this.filePath + '.corrupt'); } catch { /* best-effort preservation */ }
      console.error('DevDeck: state.json was unreadable — preserved as state.json.corrupt');
    }
    const backup = this.readValid(this.filePath + '.bak');
    if (backup) { console.error('DevDeck: recovered state from state.json.bak'); return backup; }
    return { projects: {} };
  }

  private save(): void {
    const tmp = this.filePath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
      // Mirror the just-written good state to .bak so external corruption of the live file (disk error,
      // a sync tool, a manual edit) is recoverable on the next load instead of starting from empty.
      try { copyFileSync(this.filePath, this.filePath + '.bak'); } catch { /* best-effort backup */ }
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

  // Idle hold (minutes) before the armed shutdown watcher fires — one of IDLE_HOLD_CHOICES.
  getShutdownIdleMinutes(): number {
    const v = this.state.settings?.shutdownIdleMinutes;
    return v === 5 || v === 10 || v === 20 || v === 30 ? v : 10;
  }
  setShutdownIdleMinutes(m: number): void {
    this.state.settings = { ...(this.state.settings ?? {}), shutdownIdleMinutes: m === 5 || m === 20 || m === 30 ? m : 10 };
    this.save();
  }


  setNote(path: string, note: string): void { this.mutate(path, { note }); }
  getTodos(path: string): Todo[] { return this.get(path).todos; }
  setTodos(path: string, todos: Todo[]): void { this.mutate(path, { todos: sanitizeTodos(todos) }); }
  setPinned(path: string, pinned: boolean): void { this.mutate(path, { pinned }); }
  setHidden(path: string, hidden: boolean): void { this.mutate(path, { hidden }); }
  setLastOpened(path: string, iso: string): void { this.mutate(path, { lastOpened: iso }); }
}
