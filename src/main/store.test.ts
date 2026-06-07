import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
      note: '', pinned: false, hidden: false, lastOpened: null,
    });
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
    s.setAgent('codex');
    const re = new Store(file);
    expect(re.getAgent()).toBe('codex');
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
});
