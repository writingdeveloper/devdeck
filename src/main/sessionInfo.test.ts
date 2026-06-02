import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLastSessionMs } from './sessionInfo';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-sess-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('getLastSessionMs', () => {
  it('returns the newest jsonl mtime for an encoded project dir', () => {
    const enc = 'C--g-proj';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    const older = join(d, 'a.jsonl');
    const newer = join(d, 'b.jsonl');
    writeFileSync(older, '{}');
    writeFileSync(newer, '{}');
    // force mtimes: older = 1000s, newer = 2000s (epoch seconds)
    utimesSync(older, 1000, 1000);
    utimesSync(newer, 2000, 2000);
    expect(getLastSessionMs('C:\\g\\proj', root)).toBe(2000 * 1000);
  });

  it('returns null when no session dir exists', () => {
    expect(getLastSessionMs('C:\\g\\missing', root)).toBeNull();
  });
});
