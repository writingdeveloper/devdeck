import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
      note: '', pinned: false, hidden: false, staleDays: null, lastOpened: null,
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
});
