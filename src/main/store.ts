import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreEntry, Folder } from '../shared/types';

interface StateFile {
  projects: Record<string, StoreEntry>;
  settings?: { language?: string; baseDir?: string; folders?: Folder[]; thresholds?: { freshDays: number; warnDays: number; neglectedDays: number }; agent?: string; openAtLogin?: boolean; viewMode?: 'cards' | 'list' };
}

const EMPTY: StoreEntry = {
  note: '', pinned: false, hidden: false, lastOpened: null,
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
    return { ...EMPTY, ...this.state.projects[path] };
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


  setNote(path: string, note: string): void { this.mutate(path, { note }); }
  setPinned(path: string, pinned: boolean): void { this.mutate(path, { pinned }); }
  setHidden(path: string, hidden: boolean): void { this.mutate(path, { hidden }); }
  setLastOpened(path: string, iso: string): void { this.mutate(path, { lastOpened: iso }); }
}
