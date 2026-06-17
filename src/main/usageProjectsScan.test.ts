import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listClaudeProjectDirs } from './usageProjectsScan';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-cproj-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listClaudeProjectDirs', () => {
  it('recovers {path,name} from each dir via the session cwd; skips dirs without cwd', () => {
    const a = join(root, 'C--g-foo'); mkdirSync(a);
    writeFileSync(join(a, 's.jsonl'), [JSON.stringify({ type: 'summary' }), JSON.stringify({ cwd: 'C:\\g\\foo' })].join('\n'));
    const b = join(root, 'C--g-nocwd'); mkdirSync(b);
    writeFileSync(join(b, 's.jsonl'), JSON.stringify({ type: 'summary', sessionId: 'x' }));
    const r = listClaudeProjectDirs(root);
    expect(r).toContainEqual({ path: 'C:\\g\\foo', name: 'foo' });
    expect(r.some((x) => x.path.includes('nocwd'))).toBe(false);
  });
  it('returns [] for a missing projects dir', () => {
    expect(listClaudeProjectDirs(join(root, 'nope'))).toEqual([]);
  });
});
