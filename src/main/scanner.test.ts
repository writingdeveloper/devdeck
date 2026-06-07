import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { scanRepos, scanFolders } from './scanner';

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

describe('scanFolders', () => {
  it('merges multiple roots, includes a direct repo, and dedupes by path', async () => {
    // second root
    const base2 = mkdtempSync(join(tmpdir(), 'devdeck-scan2-'));
    mkdirSync(join(base2, 'projC', '.git'), { recursive: true });
    // a standalone repo dir to add directly
    const repoDir = mkdtempSync(join(tmpdir(), 'devdeck-repo-'));
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    try {
      const out = await scanFolders([
        { path: base, kind: 'root' },        // projA, projB (from beforeEach)
        { path: base2, kind: 'root' },       // projC
        { path: repoDir, kind: 'repo' },     // the standalone repo itself
        { path: join(base, 'projA'), kind: 'repo' }, // duplicate of projA -> deduped
      ]);
      expect(out.map((p) => p.name).sort()).toEqual(['projA', 'projB', 'projC', basename(repoDir)].sort());
    } finally {
      rmSync(base2, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips a repo entry that has no .git, and a non-existent root', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'devdeck-nogit-'));
    try {
      const out = await scanFolders([
        { path: noGit, kind: 'repo' },                 // no .git -> skipped
        { path: join(noGit, 'does-not-exist'), kind: 'root' }, // missing -> skipped
      ]);
      expect(out).toEqual([]);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });
});
