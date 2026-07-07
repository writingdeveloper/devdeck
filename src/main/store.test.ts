import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devdeck-'));
  file = join(dir, 'state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Store', () => {
  it('returns a default entry for an unknown project', () => {
    const s = new Store(file);
    expect(s.get('C:\\g\\x')).toEqual({
      note: '', pinned: false, hidden: false, lastOpened: null, todos: [],
    });
  });

  it('persists todos across instances and sanitizes junk on read', () => {
    const s1 = new Store(file);
    const good = { id: 'a', text: 'ship v2', done: false, due: '2026-07-04', createdAt: '2026-07-01T00:00:00Z' };
    s1.setTodos('C:\\g\\x', [good, { id: '', text: 'bad' } as never]); // bad entry dropped on write
    const s2 = new Store(file);
    expect(s2.getTodos('C:\\g\\x')).toEqual([good]);
    expect(s2.get('C:\\g\\x').todos).toEqual([good]); // also exposed on the full entry
  });

  it('persists a note across instances', () => {
    const s1 = new Store(file);
    s1.setNote('C:\\g\\x', '다음: Task1');
    const s2 = new Store(file);
    expect(s2.get('C:\\g\\x').note).toBe('다음: Task1');
  });

  it('persists pinned and hidden flags', () => {
    const s = new Store(file);
    s.setPinned('C:\\g\\x', true);
    s.setHidden('C:\\g\\x', true);
    const reread = new Store(file);
    expect(reread.get('C:\\g\\x').pinned).toBe(true);
    expect(reread.get('C:\\g\\x').hidden).toBe(true);
  });

  it('does not leave a .tmp file behind after a successful save', () => {
    const s = new Store(file);
    s.setNote('C:\\g\\x', 'hi');
    expect(existsSync(file + '.tmp')).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('persists baseDir and thresholds', () => {
    const s = new Store(file);
    s.setBaseDir('C:\\repos');
    s.setThresholds({ freshDays: 2, warnDays: 5, neglectedDays: 14 });
    const re = new Store(file);
    expect(re.getBaseDir()).toBe('C:\\repos');
    expect(re.getThresholds()).toEqual({ freshDays: 2, warnDays: 5, neglectedDays: 14 });
  });
  it('returns null baseDir / null thresholds by default', () => {
    const s = new Store(file);
    expect(s.getBaseDir()).toBeNull();
    expect(s.getThresholds()).toBeNull();
  });

  it('persists the active agent and defaults to null', () => {
    const s = new Store(file);
    expect(s.getAgent()).toBeNull();
    s.setAgent('antigravity');
    const re = new Store(file);
    expect(re.getAgent()).toBe('antigravity');
  });

  it('persists openAtLogin and defaults to false', () => {
    const s = new Store(file);
    expect(s.getOpenAtLogin()).toBe(false);
    s.setOpenAtLogin(true);
    expect(new Store(file).getOpenAtLogin()).toBe(true);
    s.setOpenAtLogin(false);
    expect(new Store(file).getOpenAtLogin()).toBe(false);
  });

  it('persists viewMode and defaults to cards', () => {
    const s = new Store(file);
    expect(s.getViewMode()).toBe('cards');
    s.setViewMode('list');
    expect(new Store(file).getViewMode()).toBe('list');
    s.setViewMode('cards');
    expect(new Store(file).getViewMode()).toBe('cards');
  });

  it('round-trips folders: add, dedupe, remove', () => {
    const s = new Store(file);
    expect(s.getFolders()).toEqual([]);
    s.addFolder({ path: 'C:\\work', kind: 'root' });
    s.addFolder({ path: 'C:\\work', kind: 'root' }); // duplicate -> ignored
    s.addFolder({ path: 'E:\\spike', kind: 'repo' });
    const re = new Store(file);
    expect(re.getFolders()).toEqual([
      { path: 'C:\\work', kind: 'root' },
      { path: 'E:\\spike', kind: 'repo' },
    ]);
    re.removeFolder('C:\\work');
    expect(new Store(file).getFolders()).toEqual([{ path: 'E:\\spike', kind: 'repo' }]);
  });

  it('migrates a legacy baseDir into a single root folder', () => {
    const s = new Store(file);
    s.setBaseDir('C:\\repos');
    expect(s.getFolders()).toEqual([{ path: 'C:\\repos', kind: 'root' }]);
    // first explicit add persists the migrated entry plus the new one
    s.addFolder({ path: 'D:\\more', kind: 'root' });
    expect(new Store(file).getFolders()).toEqual([
      { path: 'C:\\repos', kind: 'root' },
      { path: 'D:\\more', kind: 'root' },
    ]);
  });

  it('keeps a migrated baseDir folder removed after reload', () => {
    const s = new Store(file);
    s.setBaseDir('C:\\repos');                 // legacy single base, no explicit folders
    s.removeFolder('C:\\repos');               // remove the migrated entry
    expect(new Store(file).getFolders()).toEqual([]); // must stay empty after reload
  });

  it('round-trips cockpitSessions (default [])', () => {
    const s = new Store(file);
    expect(s.getCockpitSessions()).toEqual([]);
    s.setCockpitSessions([{ projectPath: 'C:/a/dev', name: 'dev', sessionId: 's1', agentId: 'antigravity', label: 'auth' }]);
    expect(new Store(file).getCockpitSessions()).toEqual([{ projectPath: 'C:/a/dev', name: 'dev', sessionId: 's1', agentId: 'antigravity', label: 'auth' }]);
  });

  it('round-trips pendingAutoRestore and consume clears it (sanitized)', () => {
    const s = new Store(file);
    expect(s.getPendingAutoRestore()).toEqual([]);
    s.setPendingAutoRestore([
      { projectPath: 'C:/a/dev', name: 'dev', sessionId: 's1', agentId: 'claude', label: null },
      { name: 'no-path' } as never, // junk → dropped by sanitize
    ]);
    // survives an app restart (persisted)
    expect(new Store(file).getPendingAutoRestore()).toEqual([{ projectPath: 'C:/a/dev', name: 'dev', sessionId: 's1', agentId: 'claude', label: null }]);
    // consume returns the list AND clears it, so a later normal launch won't auto-restore again
    const s2 = new Store(file);
    expect(s2.consumePendingAutoRestore()).toEqual([{ projectPath: 'C:/a/dev', name: 'dev', sessionId: 's1', agentId: 'claude', label: null }]);
    expect(s2.getPendingAutoRestore()).toEqual([]);
    expect(new Store(file).getPendingAutoRestore()).toEqual([]); // cleared on disk too
  });

  it('round-trips contextWindow (default 1M; only 200k/1M allowed)', () => {
    const s = new Store(file);
    expect(s.getContextWindow()).toBe(1_000_000);
    s.setContextWindow(200_000);
    expect(new Store(file).getContextWindow()).toBe(200_000);
    s.setContextWindow(12345 as number); // junk → coerced to 1M
    expect(s.getContextWindow()).toBe(1_000_000);
  });

  it('round-trips trayAlert (default attention; bad value coerced)', () => {
    const s = new Store(file);
    expect(s.getTrayAlert()).toBe('attention');
    s.setTrayAlert('all');
    expect(new Store(file).getTrayAlert()).toBe('all');
    s.setTrayAlert('garbage' as 'off');
    expect(s.getTrayAlert()).toBe('attention');
  });

  it('sanitizes corrupted cockpitSessions on read', () => {
    const s = new Store(file);
    // bypass the typed setter to simulate a hand-corrupted state.json
    (s as unknown as { state: { settings: { cockpitSessions: unknown } } }).state.settings = { cockpitSessions: 'garbage' };
    expect(s.getCockpitSessions()).toEqual([]);
  });

  // --- corruption resilience: a broken state.json must never be silently wiped ---
  it('mirrors the last good state to a .bak sidecar on every save', () => {
    const s = new Store(file);
    s.setNote('C:\\g\\x', 'keep me');
    expect(existsSync(file + '.bak')).toBe(true);
    expect(readFileSync(file + '.bak', 'utf8')).toBe(readFileSync(file, 'utf8')); // .bak mirrors live
  });

  it('preserves a corrupt state.json as .corrupt instead of overwriting it blind', () => {
    writeFileSync(file, '{ this is not: valid json ', 'utf8'); // externally corrupted
    const s = new Store(file); // load() must not throw, must preserve the corrupt bytes
    expect(existsSync(file + '.corrupt')).toBe(true);
    expect(readFileSync(file + '.corrupt', 'utf8')).toBe('{ this is not: valid json ');
    s.setNote('C:\\g\\x', 'fresh'); // the next save writes a valid file (self-heals) without losing the .corrupt copy
    expect(existsSync(file + '.corrupt')).toBe(true);
    expect(new Store(file).get('C:\\g\\x').note).toBe('fresh');
  });

  it('recovers the last good state from .bak when the live file is corrupt', () => {
    const s1 = new Store(file);
    s1.setNote('C:\\g\\x', 'important note'); // writes state.json + .bak
    writeFileSync(file, 'CORRUPTED', 'utf8'); // live file goes bad, .bak still good
    const s2 = new Store(file); // must recover from .bak, not start empty
    expect(s2.get('C:\\g\\x').note).toBe('important note');
  });

  it('starts empty (no throw) when both the live file and .bak are unrecoverable', () => {
    writeFileSync(file, 'CORRUPT', 'utf8');
    writeFileSync(file + '.bak', 'ALSO CORRUPT', 'utf8');
    const s = new Store(file);
    expect(s.get('C:\\g\\x').note).toBe('');
    expect(existsSync(file + '.corrupt')).toBe(true); // still preserved for manual recovery
  });
});
