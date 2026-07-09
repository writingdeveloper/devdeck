import { describe, it, expect, beforeEach } from 'vitest';
import { getGitInfo, getRepoUrl, getGitBranchDirty, _clearRemoteCache } from './gitInfo';

beforeEach(() => _clearRemoteCache());

// Fake runner keyed by the git subcommand. getGitInfo now uses `status --porcelain=v2 --branch`
// (branch + dirty + ahead in ONE call) + `log -1` + a process-lifetime remote cache.
function fakeRunner(map: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    if (args.includes('rev-parse')) return map.branch ?? '';
    if (args.includes('status')) return map.status ?? '';
    if (args.includes('log')) return map.log ?? '';
    if (args.includes('config')) return map.remote ?? '';
    return '';
  };
}

const STATUS_V2 = [
  '# branch.oid abc',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 a b src/a.ts',
  '? b.ts',
].join('\n') + '\n';

describe('getGitInfo', () => {
  it('maps git output into a GitInfo object (branch/dirty/ahead from one status call)', async () => {
    const run = fakeRunner({
      status: STATUS_V2,
      log: '1717287840|scaffold\n',
      remote: 'git@github.com:writingdeveloper/devdeck.git\n',
    });
    expect(await getGitInfo('C:/g/x', run)).toEqual({
      branch: 'main',
      lastCommitMs: 1717287840000,
      lastSubject: 'scaffold',
      uncommitted: 2,
      ahead: 2,
      repoUrl: 'https://github.com/writingdeveloper/devdeck',
    });
  });

  it('reports null repoUrl when there is no github remote', async () => {
    const run = fakeRunner({ status: STATUS_V2, remote: 'git@gitlab.com:o/r.git\n' });
    expect((await getGitInfo('C:/g/x', run)).repoUrl).toBeNull();
  });

  it('caches the remote URL per directory - the config subprocess runs only on the FIRST scan', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.includes('status')) return STATUS_V2;
      if (args.includes('config')) return 'git@github.com:o/r.git\n';
      return '';
    };
    await getGitInfo('C:/g/x', run);
    const configCallsFirst = calls.filter((a) => a.includes('config')).length;
    await getGitInfo('C:/g/x', run);
    const configCallsSecond = calls.filter((a) => a.includes('config')).length;
    expect(configCallsFirst).toBe(1);
    expect(configCallsSecond).toBe(1); // no new config spawn on the refresh
    expect((await getGitInfo('C:/g/x', run)).repoUrl).toBe('https://github.com/o/r');
  });

  it('does NOT cache the remote when status failed (git absent / not a repo yet)', async () => {
    const failing = async (): Promise<string> => { throw new Error('no git'); };
    expect((await getGitInfo('C:/g/x', failing)).repoUrl).toBeNull();
    // now the repo answers - the remote must be fetched, not served as a poisoned null
    const run = fakeRunner({ status: STATUS_V2, remote: 'https://github.com/o/r.git\n' });
    expect((await getGitInfo('C:/g/x', run)).repoUrl).toBe('https://github.com/o/r');
  });

  it('reports null ahead when there is no upstream (no branch.ab line)', async () => {
    const run = fakeRunner({ status: '# branch.oid x\n# branch.head main\n' });
    expect((await getGitInfo('C:/g/x', run)).ahead).toBeNull();
  });

  it('handles a repo with no commits', async () => {
    const run = fakeRunner({ status: '# branch.oid (initial)\n# branch.head main\n', log: '' });
    const info = await getGitInfo('C:/g/x', run);
    expect(info.lastCommitMs).toBeNull();
    expect(info.uncommitted).toBe(0);
  });

  it('returns null branch when git throws (not a repo)', async () => {
    const run = async (): Promise<string> => { throw new Error('not a repo'); };
    const info = await getGitInfo('C:/g/x', run);
    expect(info.branch).toBeNull();
  });

  it('getRepoUrl returns the normalized URL, or null when the config call throws', async () => {
    const run = fakeRunner({ remote: 'https://github.com/o/r.git\n' });
    expect(await getRepoUrl('C:/g/x', run)).toBe('https://github.com/o/r');
    const throwing = async (args: string[]): Promise<string> => { if (args.includes('config')) throw new Error('x'); return ''; };
    expect(await getRepoUrl('C:/g/x', throwing)).toBeNull();
  });
});

describe('getGitBranchDirty', () => {
  const SUBCMDS = ['rev-parse', 'status', 'log', 'rev-list', 'config'];
  it('returns just branch + dirty, running ONLY rev-parse and status (not the deck-heavy log/config)', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.includes('rev-parse')) return 'feat/x\n';
      if (args.includes('status')) return ' M a.ts\n?? b.ts\n';
      return '';
    };
    expect(await getGitBranchDirty('C:/g/x', run)).toEqual({ branch: 'feat/x', dirty: 2 });
    const used = calls.map((a) => a.find((x) => SUBCMDS.includes(x))).sort();
    expect(used).toEqual(['rev-parse', 'status']); // exactly two git invocations
  });

  it('returns null branch when rev-parse throws', async () => {
    const run = async (args: string[]): Promise<string> => { if (args.includes('rev-parse')) throw new Error('x'); return ''; };
    expect((await getGitBranchDirty('C:/g/x', run)).branch).toBeNull();
  });
});
