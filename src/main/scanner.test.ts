import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepos } from './scanner';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'devdeck-scan-'));
  mkdirSync(join(base, 'projA', '.git'), { recursive: true });
  mkdirSync(join(base, 'projB', '.git'), { recursive: true });
  mkdirSync(join(base, 'notARepo'), { recursive: true });          // no .git
  mkdirSync(join(base, '__pycache__', '.git'), { recursive: true }); // ignored name
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('scanRepos', () => {
  it('returns only git repos, excluding ignored names', () => {
    const repos = scanRepos(base).map((p) => p.name).sort();
    expect(repos).toEqual(['projA', 'projB']);
  });

  it('returns absolute paths', () => {
    const repos = scanRepos(base);
    expect(repos[0].path.startsWith(base)).toBe(true);
  });
});
