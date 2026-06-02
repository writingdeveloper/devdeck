import { describe, it, expect } from 'vitest';
import { getGitInfo } from './gitInfo';

// Fake runner keyed by the git subcommand.
function fakeRunner(map: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    if (args.includes('rev-parse')) return map.branch ?? '';
    if (args.includes('log')) return map.log ?? '';
    if (args.includes('status')) return map.status ?? '';
    return '';
  };
}

describe('getGitInfo', () => {
  it('maps git output into a GitInfo object', async () => {
    const run = fakeRunner({
      branch: 'main\n',
      log: '1717287840|scaffold\n',
      status: ' M a.ts\n?? b.ts\n',
    });
    expect(await getGitInfo('C:\\g\\x', run)).toEqual({
      branch: 'main',
      lastCommitMs: 1717287840000,
      lastSubject: 'scaffold',
      uncommitted: 2,
    });
  });

  it('handles a repo with no commits', async () => {
    const run = fakeRunner({ branch: 'main\n', log: '', status: '' });
    const info = await getGitInfo('C:\\g\\x', run);
    expect(info.lastCommitMs).toBeNull();
    expect(info.uncommitted).toBe(0);
  });

  it('returns null branch when a git call throws', async () => {
    const run = async (args: string[]): Promise<string> => {
      if (args.includes('rev-parse')) throw new Error('not a repo');
      return '';
    };
    const info = await getGitInfo('C:\\g\\x', run);
    expect(info.branch).toBeNull();
  });
});
