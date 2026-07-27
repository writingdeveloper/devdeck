import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); // retry: Windows file-handle release race → ENOTEMPTY

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

  it('never descends into Windows system directories at a drive root', async () => {
    // `E:\` is a legitimate scan folder, and these sit at every drive root: `$RECYCLE.BIN` holds
    // deleted junk and `System Volume Information` throws EPERM on each refresh. Neither starts with
    // a dot, so only the explicit ignore list keeps them out.
    for (const name of ['$RECYCLE.BIN', 'System Volume Information', '$WinREAgent', 'Recovery']) {
      mkdirSync(join(base, name, 'ghost', '.git'), { recursive: true });
    }
    const repos = (await scanRepos(base)).map((p) => p.name).sort();
    expect(repos).toEqual(['projA', 'projB']);
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

  // A `repo` entry is "the user pointed at ONE folder and said this is a project" — an explicit
  // choice, so it shows up whether or not git has been initialised in it yet.
  it('keeps a repo entry that has no .git (an explicitly added single folder)', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'devdeck-nogit-'));
    try {
      const out = await scanFolders([{ path: noGit, kind: 'repo' }]);
      expect(out).toEqual([{ path: noGit, name: basename(noGit) }]);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('skips a repo entry / root that does not exist', async () => {
    const gone = join(tmpdir(), 'devdeck-does-not-exist-xyz');
    const out = await scanFolders([
      { path: gone, kind: 'repo' },   // missing -> skipped
      { path: gone, kind: 'root' },   // missing -> skipped
    ]);
    expect(out).toEqual([]);
  });

  it('skips a repo entry pointing at a FILE rather than a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdeck-file-'));
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'x');
    try {
      expect(await scanFolders([{ path: file, kind: 'repo' }])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
