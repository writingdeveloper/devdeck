import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listClaudeProjectDirs } from './usageProjectsScan';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-cproj-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listClaudeProjectDirs', () => {
  it('recovers {path,name} from each dir via the session cwd; skips dirs without cwd', async () => {
    const a = join(root, 'C--g-foo'); mkdirSync(a);
    writeFileSync(join(a, 's.jsonl'), [JSON.stringify({ type: 'summary' }), JSON.stringify({ cwd: 'C:\\g\\foo' })].join('\n'));
    const b = join(root, 'C--g-nocwd'); mkdirSync(b);
    writeFileSync(join(b, 's.jsonl'), JSON.stringify({ type: 'summary', sessionId: 'x' }));
    const r = await listClaudeProjectDirs(root);
    expect(r).toContainEqual({ path: 'C:\\g\\foo', name: 'foo' });
    expect(r.some((x) => x.path.includes('nocwd'))).toBe(false);
  });
  it('returns [] for a missing projects dir', async () => {
    expect(await listClaudeProjectDirs(join(root, 'nope'))).toEqual([]);
  });
  it('caches a recovered dir ref so its head is not re-read (a dir\'s cwd is immutable)', async () => {
    const a = join(root, 'C--g-cached'); mkdirSync(a);
    const f = join(a, 's.jsonl');
    writeFileSync(f, JSON.stringify({ cwd: 'C:\\g\\cached' }));
    const r1 = await listClaudeProjectDirs(root);
    expect(r1).toContainEqual({ path: 'C:\\g\\cached', name: 'cached' });
    rmSync(f); // the only session file vanishes; a cached lookup must still return the original ref
    const r2 = await listClaudeProjectDirs(root);
    expect(r2).toContainEqual({ path: 'C:\\g\\cached', name: 'cached' });
  });
});
