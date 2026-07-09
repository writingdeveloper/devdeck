import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitInfo } from '../shared/types';
import { parseBranch, parseLastCommit, parsePorcelainCount, parseRemoteUrl, parseStatusV2 } from '../shared/gitParse';

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

const defaultRunner: GitRunner = async (args) => {
  const { stdout } = await execFileAsync('git', args, { windowsHide: true });
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
