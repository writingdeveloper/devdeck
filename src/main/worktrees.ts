// src/main/worktrees.ts
// Separate workspaces for parallel sessions: a git worktree per session, so several agents can work
// on one project at once without touching each other's files.
//
// They live where Claude Code's own `--worktree` puts them — `<repo>/.claude/worktrees/<name>` — on a
// branch of their own. Inside the repository folder, so the scan allowlist that admits the project
// admits its workspaces too; listed in `.git/info/exclude`, so they never show up as changes in the
// project they came from.
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitRunner } from './gitInfo';

export const WORKTREE_DIR = join('.claude', 'worktrees');
export const WORKTREE_BRANCH_PREFIX = 'devdeck/';
const EXCLUDE_LINE = '/.claude/worktrees/';

export interface Worktree {
  /** The workspace folder. */
  path: string;
  /** The repository it belongs to. */
  repo: string;
  branch: string;
  /** The branch and commit it was started from. */
  baseBranch: string | null;
  baseCommit: string;
}

export interface WorktreeChanges {
  /** Files changed against the commit it started from, committed or not. */
  files: number;
  insertions: number;
  deletions: number;
  /** Commits on its branch that its base branch does not have. */
  commits: number;
  /** Uncommitted changes, untracked files included. */
  dirty: number;
}

/** A short, sortable, collision-proof name: `0121-0632-a3f`. */
export function worktreeName(now: Date, rand = randomBytes(2).toString('hex').slice(0, 3)): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rand}`;
}

/** Whether `path` is a workspace folder directly under `repo`'s worktree directory — the only kind removed. */
export function isWorktreeOf(repo: string, path: string): boolean {
  const rel = relative(join(resolve(repo), WORKTREE_DIR), resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep) && !rel.includes('/');
}

/** The repository a workspace folder belongs to, read off its path; null for any other folder. */
export function repoOfWorktree(path: string): string | null {
  const parts = resolve(path).split(/[\\/]/);
  const at = parts.length - 3;
  if (at < 1 || parts[at] !== '.claude' || parts[at + 1] !== 'worktrees' || !parts[at + 2]) return null;
  return parts.slice(0, at).join(sep);
}

/** Start a workspace on a new branch from the repository's current commit. */
export async function createWorktree(repo: string, run: GitRunner, now = new Date()): Promise<Worktree> {
  const top = (await run(['-C', repo, 'rev-parse', '--show-toplevel'])).trim();
  if (!top || resolve(top).toLowerCase() !== resolve(repo).toLowerCase()) {
    throw new Error('not the top folder of a git repository');
  }
  const baseCommit = (await run(['-C', repo, 'rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error('the repository has no commits yet');
  const head = (await run(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const name = worktreeName(now);
  const branch = WORKTREE_BRANCH_PREFIX + name;
  const path = join(resolve(repo), WORKTREE_DIR, name);
  await excludeWorktrees(repo, run);
  await mkdir(join(resolve(repo), WORKTREE_DIR), { recursive: true });
  await run(['-C', repo, 'worktree', 'add', '-b', branch, path, baseCommit]);
  return { path, repo: resolve(repo), branch, baseBranch: head && head !== 'HEAD' ? head : null, baseCommit };
}

/** Keep the workspaces out of the project's own status: one line in the repository-local exclude file. */
async function excludeWorktrees(repo: string, run: GitRunner): Promise<void> {
  const common = (await run(['-C', repo, 'rev-parse', '--git-common-dir'])).trim();
  const file = join(resolve(repo, common), 'info', 'exclude');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { /* no exclude file yet */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return;
  await mkdir(join(resolve(repo, common), 'info'), { recursive: true });
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}# DevDeck parallel-session workspaces\n${EXCLUDE_LINE}\n`);
}

/** What a workspace has done since it started. */
export async function worktreeChanges(w: Pick<Worktree, 'path' | 'baseCommit' | 'baseBranch'>, run: GitRunner): Promise<WorktreeChanges> {
  const [stat, status, ahead] = await Promise.all([
    run(['-C', w.path, 'diff', '--shortstat', w.baseCommit]).catch(() => ''),
    run(['-C', w.path, 'status', '--porcelain']).catch(() => ''),
    run(['-C', w.path, 'rev-list', '--count', `${w.baseBranch ?? w.baseCommit}..HEAD`]).catch(() => '0'),
  ]);
  const num = (re: RegExp): number => Number(re.exec(stat)?.[1] ?? 0);
  const untracked = status.split(/\r?\n/).filter((l) => l.startsWith('??')).length;
  return {
    files: num(/(\d+) files? changed/) + untracked,
    insertions: num(/(\d+) insertions?/),
    deletions: num(/(\d+) deletions?/),
    commits: Number(ahead.trim()) || 0,
    dirty: status.split(/\r?\n/).filter((l) => l.trim()).length,
  };
}

/**
 * Remove a workspace and its branch. Refused while it holds work that exists nowhere else —
 * uncommitted changes, or commits its base branch does not have — unless `force`.
 */
export async function removeWorktree(w: Pick<Worktree, 'path' | 'repo' | 'branch' | 'baseCommit' | 'baseBranch'>, run: GitRunner, force: boolean): Promise<{ removed: boolean; reason?: 'unsaved' | 'unmerged' }> {
  if (!isWorktreeOf(w.repo, w.path) || !w.branch.startsWith(WORKTREE_BRANCH_PREFIX)) throw new Error('not a DevDeck workspace');
  if (!force) {
    const c = await worktreeChanges(w, run);
    if (c.dirty > 0) return { removed: false, reason: 'unsaved' };
    if (c.commits > 0) return { removed: false, reason: 'unmerged' };
  }
  try {
    await run(['-C', w.repo, 'worktree', 'remove', ...(force ? ['--force'] : []), w.path]);
  } catch (err) {
    // On Windows git can drop the worktree from its list and still fail to delete the folder, held
    // a moment longer by a process that has just exited; every later attempt then says "not a
    // working tree". Once git no longer knows it, what is left is only the folder.
    if (await isRegistered(w.repo, w.path, run)) throw err;
  }
  // The folder was checked above to be one of ours; remove what git left behind.
  await rm(w.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  await run(['-C', w.repo, 'worktree', 'prune']).catch(() => '');
  await run(['-C', w.repo, 'branch', force ? '-D' : '-d', w.branch]).catch(() => '');
  return { removed: true };
}

async function isRegistered(repo: string, path: string, run: GitRunner): Promise<boolean> {
  const list = await run(['-C', repo, 'worktree', 'list', '--porcelain']).catch(() => '');
  const want = resolve(path).toLowerCase();
  return list.split(/\r?\n/).some((l) => l.startsWith('worktree ') && resolve(l.slice(9)).toLowerCase() === want);
}
