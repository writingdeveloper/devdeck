import { describe, it, expect } from 'vitest';
import { getGitInfo, getRepoUrl } from './gitInfo';

// Fake runner keyed by the git subcommand.
function fakeRunner(map: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    if (args.includes('rev-parse')) return map.branch ?? '';
    if (args.includes('rev-list')) return map.ahead ?? '';
    if (args.includes('log')) return map.log ?? '';
    if (args.includes('status')) return map.status ?? '';
    if (args.includes('config')) return map.remote ?? '';
    return '';
  };
}

describe('getGitInfo', () => {
  it('maps git output into a GitInfo object', async () => {
    const run = fakeRunner({
      branch: 'main\n',
      log: '1717287840|scaffold\n',
      status: ' M a.ts\n?? b.ts\n',
      ahead: '2\n',
      remote: 'git@github.com:writingdeveloper/devdeck.git\n',
    });
    expect(await getGitInfo('C:\\g\\x', run)).toEqual({
      branch: 'main',
      lastCommitMs: 1717287840000,
      lastSubject: 'scaffold',
      uncommitted: 2,
      ahead: 2,
      repoUrl: 'https://github.com/writingdeveloper/devdeck',
    });
  });

  it('reports null repoUrl when there is no github remote', async () => {
    const run = fakeRunner({ branch: 'main\n', remote: 'git@gitlab.com:o/r.git\n' });
    expect((await getGitInfo('C:\\g\\x', run)).repoUrl).toBeNull();
  });

  it('getRepoUrl returns the normalized URL, or null when the config call throws', async () => {
    const run = fakeRunner({ remote: 'https://github.com/o/r.git\n' });
    expect(await getRepoUrl('C:\\g\\x', run)).toBe('https://github.com/o/r');
    const throwing = async (args: string[]): Promise<string> => { if (args.includes('config')) throw new Error('x'); return ''; };
    expect(await getRepoUrl('C:\\g\\x', throwing)).toBeNull();
  });

  it('reports null ahead when there is no upstream (rev-list throws)', async () => {
    const run = async (args: string[]): Promise<string> => {
      if (args.includes('rev-list')) throw new Error('no upstream');
      if (args.includes('rev-parse')) return 'main\n';
      return '';
    };
    expect((await getGitInfo('C:\\g\\x', run)).ahead).toBeNull();
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
