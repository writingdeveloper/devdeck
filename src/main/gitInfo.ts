import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitInfo } from '../shared/types';
import { parseBranch, parseLastCommit, parsePorcelainCount, parseAheadCount, parseRemoteUrl } from '../shared/gitParse';

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

export async function getGitInfo(dir: string, run: GitRunner = defaultRunner): Promise<GitInfo> {
  const [branchOut, logOut, statusOut, aheadOut, remoteOut] = await Promise.all([
    safe(run, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    safe(run, ['-C', dir, 'log', '-1', '--format=%ct|%s']),
    safe(run, ['-C', dir, 'status', '--porcelain']),
    safe(run, ['-C', dir, 'rev-list', '--count', '@{upstream}..HEAD']),
    safe(run, ['-C', dir, 'config', '--get', 'remote.origin.url']),
  ]);
  const { lastCommitMs, lastSubject } = parseLastCommit(logOut ?? '');
  return {
    branch: branchOut == null ? null : parseBranch(branchOut),
    lastCommitMs,
    lastSubject,
    uncommitted: parsePorcelainCount(statusOut ?? ''),
    ahead: aheadOut == null ? null : parseAheadCount(aheadOut),
    repoUrl: parseRemoteUrl(remoteOut ?? ''),
  };
}

/** Read just the GitHub repo URL for a directory (used on-demand when opening the repo page). */
export async function getRepoUrl(dir: string, run: GitRunner = defaultRunner): Promise<string | null> {
  const out = await safe(run, ['-C', dir, 'config', '--get', 'remote.origin.url']);
  return parseRemoteUrl(out ?? '');
}
