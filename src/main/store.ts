import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { StoreEntry, Folder } from '../shared/types';
import { sanitizePersistedList, type PersistedSession } from '../shared/cockpitPersist';
import { sanitizeTodos, type Todo, type TodoSaveResult } from '../shared/tasks';
import { sanitizeWindowBounds, type WindowBounds } from '../shared/windowBounds';
import { LOCAL_MACHINE_ID, isValidMachineId, sanitizeMachineName } from '../shared/link/machine';
import { sanitizeKnownHosts, sanitizePairedDevices, type KnownHost, type PairedDevice } from './link/devices';
import { LINK_DEFAULT_PORT } from './link/protocol';

interface StateFile {
  projects: Record<string, StoreEntry>;
  settings?: { language?: string; baseDir?: string; folders?: Folder[]; thresholds?: { freshDays: number; warnDays: number; neglectedDays: number }; agent?: string; openAtLogin?: boolean; viewMode?: 'cards' | 'list'; cockpitSessions?: PersistedSession[]; trayAlert?: 'off' | 'attention' | 'all'; pendingAutoRestore?: PersistedSession[]; contextWindow?: number; shutdownIdleMinutes?: number; cockpitSidebarCollapsed?: boolean; sessionSummary?: boolean; aiSessionSummary?: boolean; windowBounds?: WindowBounds; machineId?: string; machineName?: string; linkHostMode?: boolean; linkPort?: number; linkDevices?: PairedDevice[]; linkHosts?: KnownHost[] };
}

const EMPTY: StoreEntry = {
  note: '', pinned: false, hidden: false, lastOpened: null, todos: [],
};

export class Store {
  private state: StateFile;
  private committed: string;

  constructor(private readonly filePath: string) {
    this.state = this.load();
    this.committed = JSON.stringify(this.state);
  }

  /** Parse a state file, or null if missing/unreadable/not an object (so callers can fall back). */
  private readValid(path: string): StateFile | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const object = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (!object(parsed)) return null;
      if (parsed.projects !== undefined && !object(parsed.projects)) return null;
      if (parsed.settings !== undefined && !object(parsed.settings)) return null;
      if (parsed.settings?.folders !== undefined && (!Array.isArray(parsed.settings.folders)
        || !parsed.settings.folders.every((f: unknown) => object(f) && typeof (f as Folder).path === 'string'
          && ['root', 'repo'].includes((f as Folder).kind)))) return null;
      const projects = parsed.projects ?? {};
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
      const serialized = JSON.stringify(this.state, null, 2);
      writeFileSync(tmp, serialized, 'utf8');
      renameSync(tmp, this.filePath);
      this.committed = serialized;
      // Mirror the just-written good state to .bak so external corruption of the live file (disk error,
      // a sync tool, a manual edit) is recoverable on the next load instead of starting from empty.
      try { copyFileSync(this.filePath, this.filePath + '.bak'); } catch { /* best-effort backup */ }
    } catch (err) {
      this.state = JSON.parse(this.committed) as StateFile;
      console.error('DevDeck: failed to persist state', err);
      throw err;
    }
  }

  get(path: string): StoreEntry {
    const e = { ...EMPTY, ...this.state.projects[path] };
    return { ...e, todos: sanitizeTodos(e.todos), todosRevision: Number.isSafeInteger(e.todosRevision) && e.todosRevision! >= 0 ? e.todosRevision : 0 }; // never hand out unvalidated on-disk todos
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
  /**
   * Register a folder, or — when it is already registered — update its kind in place, so re-adding a
   * path as the other kind switches it (the only way to change "scan for repos" ↔ "this one folder is
   * a project" without removing the entry first). Position in the list is preserved.
   */
  addFolder(folder: Folder): void {
    const cur = this.state.settings?.folders ?? this.getFolders();
    const same = (p: string) => resolve(p).replace(/[\\/]+$/, '') === resolve(folder.path).replace(/[\\/]+$/, '');
    const folders = cur.some((x) => same(x.path))
      ? cur.map((x) => (same(x.path) ? folder : x))
      : [...cur, folder];
    this.state.settings = { ...(this.state.settings ?? {}), folders };
    this.save();
  }
  removeFolder(path: string): void {
    const cur = this.state.settings?.folders ?? this.getFolders();
    const target = resolve(path).replace(/[\\/]+$/, '');
    const folders = cur.filter((x) => resolve(x.path).replace(/[\\/]+$/, '') !== target);
    this.state.settings = { ...(this.state.settings ?? {}), folders };
    this.save();
  }

  getThresholds(): { freshDays: number; warnDays: number; neglectedDays: number } | null { return this.state.settings?.thresholds ?? null; }
  setThresholds(thresholds: { freshDays: number; warnDays: number; neglectedDays: number }): void { this.state.settings = { ...(this.state.settings ?? {}), thresholds }; this.save(); }

  getAgent(): string | null { return this.state.settings?.agent ?? null; }
  setAgent(agent: string): void { this.state.settings = { ...(this.state.settings ?? {}), agent }; this.save(); }

  getOpenAtLogin(): boolean { return this.state.settings?.openAtLogin ?? false; }
  setOpenAtLogin(openAtLogin: boolean): void { this.state.settings = { ...(this.state.settings ?? {}), openAtLogin }; this.save(); }

  getViewMode(): 'cards' | 'list' { return this.state.settings?.viewMode === 'cards' ? 'cards' : 'list'; }
  setViewMode(viewMode: 'cards' | 'list'): void { this.state.settings = { ...(this.state.settings ?? {}), viewMode }; this.save(); }

  getCockpitSessions(): PersistedSession[] {
    const raw = this.state.settings?.cockpitSessions;
    const sessions = sanitizePersistedList(raw);
    if (JSON.stringify(raw ?? []) !== JSON.stringify(sessions)) {
      this.state.settings = { ...(this.state.settings ?? {}), cockpitSessions: sessions };
      this.save();
    }
    return sessions;
  }
  setCockpitSessions(list: PersistedSession[]): void { this.state.settings = { ...(this.state.settings ?? {}), cockpitSessions: sanitizePersistedList(list) }; this.save(); }

  // The cockpit sessions that were LIVE when the user restarted for an update — auto-restored once on
  // the next launch (its presence is the "restarted for update" signal), then consumed/cleared.
  getPendingAutoRestore(): PersistedSession[] {
    const raw = this.state.settings?.pendingAutoRestore;
    const sessions = sanitizePersistedList(raw);
    if (JSON.stringify(raw ?? []) !== JSON.stringify(sessions)) {
      this.state.settings = { ...(this.state.settings ?? {}), pendingAutoRestore: sessions };
      this.save();
    }
    return sessions;
  }
  setPendingAutoRestore(list: PersistedSession[]): void { this.state.settings = { ...(this.state.settings ?? {}), pendingAutoRestore: sanitizePersistedList(list) }; this.save(); }
  consumePendingAutoRestore(): PersistedSession[] { const l = this.getPendingAutoRestore(); this.setPendingAutoRestore([]); return l; }

  // Context window (tokens) for the cockpit's per-session context % — 1M (Claude's beta) or the 200k default.
  getContextWindow(): number { return this.state.settings?.contextWindow === 200_000 ? 200_000 : 1_000_000; }
  setContextWindow(w: number): void { this.state.settings = { ...(this.state.settings ?? {}), contextWindow: w === 200_000 ? 200_000 : 1_000_000 }; this.save(); }

  // Window geometry across launches. DevDeck reopened at a fixed 1000x720 every time no matter what
  // the user had resized it to, which is too small to hold the sidebar, a full project row and a
  // terminal at once — so the app arrived already clipping its own content on every launch.
  getWindowBounds(): WindowBounds | null { return sanitizeWindowBounds(this.state.settings?.windowBounds); }
  setWindowBounds(bounds: WindowBounds): void {
    const clean = sanitizeWindowBounds(bounds);
    if (!clean) return;
    this.state.settings = { ...(this.state.settings ?? {}), windowBounds: clean };
    this.save();
  }

  /**
   * This install's stable identity, generated once and kept forever. It is what a paired machine
   * addresses, and what machine-scoped keys are built from, so it must survive every restart — a
   * regenerated id would orphan the other machine's pairing and every remote tile pointing here.
   */
  getMachineId(): string {
    const existing = this.state.settings?.machineId;
    if (isValidMachineId(existing) && existing !== LOCAL_MACHINE_ID) return existing;
    const machineId = randomUUID();
    this.state.settings = { ...(this.state.settings ?? {}), machineId };
    this.save();
    return machineId;
  }

  /** Display name for this machine; the hostname is what the person already calls it. */
  getMachineName(): string { return sanitizeMachineName(this.state.settings?.machineName, hostname()); }
  setMachineName(name: string): void {
    this.state.settings = { ...(this.state.settings ?? {}), machineName: sanitizeMachineName(name, hostname()) };
    this.save();
  }

  // ---- DevDeck Link ----
  // Accepting connections is OFF until someone turns it on. A remote shell is not something an
  // update should quietly switch on for an existing install.
  getLinkHostMode(): boolean { return this.state.settings?.linkHostMode === true; }
  setLinkHostMode(on: boolean): void {
    this.state.settings = { ...(this.state.settings ?? {}), linkHostMode: on === true };
    this.save();
  }

  getLinkPort(): number {
    const port = this.state.settings?.linkPort;
    return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535 ? (port as number) : LINK_DEFAULT_PORT;
  }
  setLinkPort(port: number): void {
    this.state.settings = { ...(this.state.settings ?? {}), linkPort: this.coercePort(port) };
    this.save();
  }
  private coercePort(port: number): number {
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : LINK_DEFAULT_PORT;
  }

  /** Devices allowed to connect TO this machine. Sanitized on both read and write: a corrupted entry
   *  must degrade to "cannot connect", never to "connects with more access than was granted". */
  getPairedDevices(): PairedDevice[] { return sanitizePairedDevices(this.state.settings?.linkDevices); }
  setPairedDevices(devices: PairedDevice[]): void {
    this.state.settings = { ...(this.state.settings ?? {}), linkDevices: sanitizePairedDevices(devices) };
    this.save();
  }

  /** Machines this one connects to, with the address that last answered. */
  getKnownHosts(): KnownHost[] { return sanitizeKnownHosts(this.state.settings?.linkHosts, this.getLinkPort()); }
  setKnownHosts(hosts: KnownHost[]): void {
    this.state.settings = { ...(this.state.settings ?? {}), linkHosts: sanitizeKnownHosts(hosts, this.getLinkPort()) };
    this.save();
  }

  // Whether the cockpit's session sidebar is collapsed (terminal gets the full width).
  getCockpitSidebarCollapsed(): boolean { return this.state.settings?.cockpitSidebarCollapsed === true; }
  setCockpitSidebarCollapsed(collapsed: boolean): void { this.state.settings = { ...(this.state.settings ?? {}), cockpitSidebarCollapsed: collapsed === true }; this.save(); }

  // The cockpit sidebar's per-session "what's happening" line. On by default: it is the whole point of
  // not having to rename a long-running session by hand.
  getSessionSummary(): boolean { return this.state.settings?.sessionSummary !== false; }
  setSessionSummary(on: boolean): void { this.state.settings = { ...(this.state.settings ?? {}), sessionSummary: on === true }; this.save(); }

  // Opt-in AI refinement of that line (a haiku call per finished turn — it spends usage, so default off).
  getAiSessionSummary(): boolean { return this.state.settings?.aiSessionSummary === true; }
  setAiSessionSummary(on: boolean): void { this.state.settings = { ...(this.state.settings ?? {}), aiSessionSummary: on === true }; this.save(); }

  getTrayAlert(): 'off' | 'attention' | 'all' { const t = this.state.settings?.trayAlert; return t === 'off' || t === 'all' ? t : 'attention'; }
  setTrayAlert(t: 'off' | 'attention' | 'all'): void { this.state.settings = { ...(this.state.settings ?? {}), trayAlert: t === 'off' || t === 'all' ? t : 'attention' }; this.save(); }

  // Idle hold (minutes) before the armed shutdown watcher fires — one of IDLE_HOLD_CHOICES.
  getShutdownIdleMinutes(): number {
    const v = this.state.settings?.shutdownIdleMinutes;
    return v === 5 || v === 10 || v === 20 || v === 30 ? v : 10;
  }
  setShutdownIdleMinutes(m: number): void {
    this.state.settings = { ...(this.state.settings ?? {}), shutdownIdleMinutes: m === 5 || m === 10 || m === 20 || m === 30 ? m : 10 };
    this.save();
  }


  setNote(path: string, note: string): void { this.mutate(path, { note }); }
  getTodos(path: string): Todo[] { return this.get(path).todos; }
  /** Compare and persist without yielding: local and Link callers share this Store. */
  saveTodos(path: string, todos: unknown, expectedRevision: number): TodoSaveResult {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('TASKS_INVALID_REVISION');
    if (!Array.isArray(todos) || todos.length > 200) throw new Error('TASKS_INVALID_LIST: maximum 200 tasks');
    const current = this.get(path);
    const revision = current.todosRevision ?? 0;
    if (revision !== expectedRevision) return { ok: false, todos: current.todos, revision };
    const clean = sanitizeTodos(todos);
    if (JSON.stringify(clean) === JSON.stringify(current.todos)) return { ok: true, todos: clean, revision };
    if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('TASKS_REVISION_EXHAUSTED');
    this.mutate(path, { todos: clean, todosRevision: revision + 1 });
    return { ok: true, todos: clean, revision: revision + 1 };
  }
  setPinned(path: string, pinned: boolean): void { this.mutate(path, { pinned }); }
  setHidden(path: string, hidden: boolean): void { this.mutate(path, { hidden }); }
  setLastOpened(path: string, iso: string): void { this.mutate(path, { lastOpened: iso }); }
}
