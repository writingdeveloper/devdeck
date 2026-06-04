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
  it('returns only git repos, excluding ignored names', async () => {
    const repos = (await scanRepos(base)).map((p) => p.name).sort();
    expect(repos).toEqual(['projA', 'projB']);
  });

  it('returns absolute paths', async () => {
    const repos = await scanRepos(base);
    expect(repos[0].path.startsWith(base)).toBe(true);
  });

  it('finds org/repo (depth 2) but not repos inside a repo or beyond maxDepth', async () => {
    mkdirSync(join(base, 'org', 'repoX', '.git'), { recursive: true });   // depth-2 repo under a non-repo
    mkdirSync(join(base, 'org', 'repoY', '.git'), { recursive: true });
    mkdirSync(join(base, 'projA', 'nested', '.git'), { recursive: true }); // inside a repo -> NOT scanned
    mkdirSync(join(base, 'deep', 'a', 'b', '.git'), { recursive: true });  // depth 3 -> NOT scanned
    const repos = (await scanRepos(base)).map((p) => p.name).sort();
    expect(repos).toEqual(['projA', 'projB', 'repoX', 'repoY']);
  });

  it('respects an explicit maxDepth of 1 (top level only)', async () => {
    mkdirSync(join(base, 'org', 'repoX', '.git'), { recursive: true });
    const repos = (await scanRepos(base, 1)).map((p) => p.name).sort();
    expect(repos).toEqual(['projA', 'projB']);
  });
});
