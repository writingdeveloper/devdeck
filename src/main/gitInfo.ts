import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitInfo } from '../shared/types';
import { parseBranch, parseLastCommit, parsePorcelainCount, parseRemoteUrl, parseStatusV2 } from '../shared/gitParse';
import { parseRecentCommits } from '../shared/projectMemory';
import type { RecentCommit } from '../shared/types';

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

/**
 * How long a single git command may take before it is given up on.
 *
 * There was no limit at all, and that is the difference between "slow" and the thing users call
 * infinite loading. The deck runs these through a pool of eight workers and waits for all of them:
 * one git that never returns — an index.lock left by a crashed process, a credential helper waiting
 * on a prompt nobody can see, a scan root inside a cloud-synced folder that is busy rehydrating —
 * parks a worker forever, and `projects:list` never resolves. The deck then shows its skeleton for
 * the rest of the session. The reporter's scan root is a OneDrive folder with 200,000 files in it.
 *
 * Ten seconds is far past any healthy call (a status on a large repository here is ~25 ms) and far
 * short of "forever". A timed-out call reports nothing, which the deck already handles: git
 * information is decoration on a project row, never the row itself.
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * A porcelain status on a big, dirty repository is easily past the 1 MB Node allows by default, and
 * exceeding it kills the process and rejects — so the whole row loses its git information because it
 * had too MUCH to say. Sized for tens of thousands of changed paths.
 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

const defaultRunner: GitRunner = async (args) => {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    // SIGTERM is the default and is ignored on Windows for a process that is not responding; git
    // spawns children (credential helpers, pagers) and this has to actually end them.
    killSignal: 'SIGKILL',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

async function safe(run: GitRunner, args: string[]): Promise<string | null> {
  try {
    return await run(args);
  } catch {
    return null;
  }
}

// remote.origin.url is effectively immutable for a repo — cache it for the process lifetime so the
// deck refresh doesn't re-spawn `git config` per project every ~45s. (A changed remote shows up after
// an app restart; acceptable for cutting a whole subprocess per project per refresh.)
const _remoteCache = new Map<string, string | null>();
/** Test-only: reset the remote-url cache between tests. */
export function _clearRemoteCache(): void { _remoteCache.clear(); }

/**
 * Deck git info in TWO subprocesses per project (was five): `status --porcelain=v2 --branch` answers
 * branch + dirty + ahead at once, `log -1` gives the last commit, and the remote URL comes from the
 * process-lifetime cache (one extra spawn only the first time a repo is seen). At 100 projects per
 * refresh that's ~200 process launches instead of ~500.
 */
export async function getGitInfo(dir: string, run: GitRunner = defaultRunner): Promise<GitInfo> {
  const remoteCached = _remoteCache.get(dir);
  const [statusOut, logOut, remoteOut] = await Promise.all([
    safe(run, ['-C', dir, 'status', '--porcelain=v2', '--branch']),
    safe(run, ['-C', dir, 'log', '-1', '--format=%ct|%s']),
    remoteCached !== undefined ? Promise.resolve(null) : safe(run, ['-C', dir, 'config', '--get', 'remote.origin.url']),
  ]);
  const { lastCommitMs, lastSubject } = parseLastCommit(logOut ?? '');
  const status = parseStatusV2(statusOut ?? '');
  let repoUrl: string | null;
  if (remoteCached !== undefined) {
    repoUrl = remoteCached;
  } else {
    repoUrl = parseRemoteUrl(remoteOut ?? '');
    if (statusOut != null) _remoteCache.set(dir, repoUrl); // only cache when the repo actually answered (git present, real repo)
  }
  return {
    branch: status.branch,
    lastCommitMs,
    lastSubject,
    uncommitted: status.dirty,
    ahead: status.ahead,
    repoUrl,
  };
}

/** Read just the GitHub repo URL for a directory (used on-demand when opening the repo page). */
export async function getRepoUrl(dir: string, run: GitRunner = defaultRunner): Promise<string | null> {
  const out = await safe(run, ['-C', dir, 'config', '--get', 'remote.origin.url']);
  return parseRemoteUrl(out ?? '');
}

/**
 * Just the branch + uncommitted count (2 git calls). The cockpit re-reads this per session on a slow
 * tick, so it skips the deck's heavier 5-call getGitInfo (which also fetches log/upstream/remote) —
 * with many open sessions that trims the periodic git-subprocess burst by 60%.
 */
export async function getGitBranchDirty(dir: string, run: GitRunner = defaultRunner): Promise<{ branch: string | null; dirty: number }> {
  const [branchOut, statusOut] = await Promise.all([
    safe(run, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    safe(run, ['-C', dir, 'status', '--porcelain']),
  ]);
  return {
    branch: branchOut == null ? null : parseBranch(branchOut),
    dirty: parsePorcelainCount(statusOut ?? ''),
  };
}

/** Bounded history for the on-demand Memory dialog. Unlike deck Git reads, failure is observable. */
export async function getRecentCommits(dir: string, limit = 20, run: GitRunner = defaultRunner): Promise<RecentCommit[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const raw = await run(['-C', dir, 'log', `-${bounded}`, '--format=%h%x1f%at%x1f%s%x1e']);
  return parseRecentCommits(raw);
}
