import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGitRunner } from './gitInfo';
import { createWorktree, isWorktreeOf, removeWorktree, repoOfWorktree, worktreeChanges, worktreeName } from './worktrees';

const run = createGitRunner();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'devdeck-wt-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'qa@example.invalid');
  git(repo, 'config', 'user.name', 'QA');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 5 }); });

describe('parallel-session workspaces', () => {
  it('starts one on its own branch where Claude Code keeps worktrees, and keeps it out of the project\'s status', async () => {
    const w = await createWorktree(repo, run, new Date(2026, 9, 21, 6, 32));
    expect(w.path).toMatch(/[\\/]\.claude[\\/]worktrees[\\/]1021-0632-[0-9a-f]{3}$/);
    expect(w.branch).toMatch(/^devdeck\/1021-0632-/);
    expect(w.baseBranch).toBe('main');
    expect(existsSync(join(w.path, 'a.txt'))).toBe(true);
    expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(w.branch);
    // The project itself still looks clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/worktrees/');
    // A second one does not add the exclude line twice.
    await createWorktree(repo, run);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/\/\.claude\/worktrees\//g)).toHaveLength(1);
  });

  it('counts what it has done: changed files, commits, unsaved work', async () => {
    const w = await createWorktree(repo, run);
    writeFileSync(join(w.path, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(w.path, 'new.txt'), 'x\n');
    expect(await worktreeChanges(w, run)).toMatchObject({ files: 2, insertions: 1, commits: 0, dirty: 2 });
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-q', '-m', 'work');
    expect(await worktreeChanges(w, run)).toMatchObject({ files: 2, commits: 1, dirty: 0 });
  });

  it('refuses to remove one holding work that exists nowhere else, unless told to', async () => {
    const w = await createWorktree(repo, run);
    writeFileSync(join(w.path, 'b.txt'), 'b\n');
    expect(await removeWorktree(w, run, false)).toEqual({ removed: false, reason: 'unsaved' });
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-q', '-m', 'work');
    expect(await removeWorktree(w, run, false)).toEqual({ removed: false, reason: 'unmerged' });
    expect(existsSync(w.path)).toBe(true);
    expect(await removeWorktree(w, run, true)).toEqual({ removed: true });
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, 'branch', '--list', w.branch)).toBe('');
  });

  it('removes a clean one, and its branch', async () => {
    const w = await createWorktree(repo, run);
    expect(await removeWorktree(w, run, false)).toEqual({ removed: true });
    expect(git(repo, 'branch', '--list', w.branch)).toBe('');
  });

  it('never removes a folder that is not one of its workspaces', async () => {
    await expect(removeWorktree({ path: repo, repo, branch: 'devdeck/x', baseCommit: 'HEAD', baseBranch: 'main' }, run, true)).rejects.toThrow('not a DevDeck workspace');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  });

  it('refuses a folder that is not the top of a repository, or one with no commits', async () => {
    await expect(createWorktree(join(repo, '.git'), run)).rejects.toThrow();
    const empty = mkdtempSync(join(tmpdir(), 'devdeck-wt-empty-'));
    git(empty, 'init', '-q');
    await expect(createWorktree(empty, run)).rejects.toThrow();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('workspace paths', () => {
  it('knows its own folders and nothing else', () => {
    const r = join('C:', 'g', 'proj');
    expect(isWorktreeOf(r, join(r, '.claude', 'worktrees', '1021-0632-abc'))).toBe(true);
    expect(isWorktreeOf(r, join(r, '.claude', 'worktrees'))).toBe(false);
    expect(isWorktreeOf(r, join(r, '.claude', 'worktrees', 'a', 'b'))).toBe(false);
    expect(isWorktreeOf(r, join(r, 'src'))).toBe(false);
    expect(repoOfWorktree(join(r, '.claude', 'worktrees', 'x'))).toBe(resolve(r));
    expect(repoOfWorktree(join(r, 'src'))).toBeNull();
  });

  it('names them by time with a random tail', () => {
    expect(worktreeName(new Date(2026, 0, 2, 3, 4), 'abc')).toBe('0102-0304-abc');
  });
});

it('finishes the job when git has dropped a workspace but left its folder behind (Windows)', async () => {
  const w = await createWorktree(repo, run);
  // What a locked folder leaves: git no longer lists it, the folder is still there.
  git(repo, 'worktree', 'remove', '--force', w.path);
  mkdirSync(w.path, { recursive: true });
  writeFileSync(join(w.path, 'leftover.txt'), 'x');
  expect(await removeWorktree(w, run, true)).toEqual({ removed: true });
  expect(existsSync(w.path)).toBe(false);
});

it('knows a repository reached through another spelling of its path (8.3 name, symlink, junction)', async () => {
  // CI's temp folder is C:\Users\RUNNER~1\..., macOS's /var is /private/var: git answers with the
  // long, real path, and a plain comparison refused the repository's own top folder.
  const link = join(tmpdir(), `devdeck-wt-link-${Date.now()}`);
  symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const w = await createWorktree(link, run);
    expect(existsSync(join(w.path, 'a.txt'))).toBe(true);
    expect(await removeWorktree(w, run, false)).toEqual({ removed: true });
  } finally { rmSync(link, { recursive: false, force: true }); }
});
