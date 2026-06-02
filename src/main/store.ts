import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { StoreEntry } from '../shared/types';

interface StateFile {
  projects: Record<string, StoreEntry>;
}

const EMPTY: StoreEntry = {
  note: '', pinned: false, hidden: false, staleDays: null, lastOpened: null,
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
      return { projects: parsed.projects ?? {} };
    } catch {
      return { projects: {} };
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
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

  setNote(path: string, note: string): void { this.mutate(path, { note }); }
  setPinned(path: string, pinned: boolean): void { this.mutate(path, { pinned }); }
  setHidden(path: string, hidden: boolean): void { this.mutate(path, { hidden }); }
  setLastOpened(path: string, iso: string): void { this.mutate(path, { lastOpened: iso }); }
}
