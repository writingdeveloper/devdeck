import { describe, it, expect } from 'vitest';
import { buildProjectList, type BuildDeps } from './projects';
import type { GitInfo } from '../shared/types';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function deps(over: Partial<BuildDeps>): BuildDeps {
  return {
    baseDir: 'C:\\g',
    nowMs: NOW,
    scan: () => [
      { path: 'C:\\g\\fresh', name: 'fresh' },
      { path: 'C:\\g\\old', name: 'old' },
    ],
    git: async (dir): Promise<GitInfo> => ({
      branch: 'main',
      lastCommitMs: dir.endsWith('fresh') ? NOW - 3_600_000 : NOW - 10 * DAY,
      lastSubject: 'x',
      uncommitted: 0,
    }),
    session: () => null,
    getEntry: () => ({ note: '', pinned: false, hidden: false, staleDays: null, lastOpened: null }),
    ...over,
  };
}

describe('buildProjectList', () => {
  it('sorts by activity descending', async () => {
    const list = await buildProjectList(deps({}));
    expect(list.map((p) => p.name)).toEqual(['fresh', 'old']);
    expect(list[0].stale.level).toBe('fresh');
    expect(list[1].stale.level).toBe('neglected');
  });

  it('excludes hidden projects', async () => {
    const list = await buildProjectList(deps({
      getEntry: (path) => ({
        note: '', pinned: false, hidden: path.endsWith('old'), staleDays: null, lastOpened: null,
      }),
    }));
    expect(list.map((p) => p.name)).toEqual(['fresh']);
  });

  it('floats pinned projects to the top regardless of activity', async () => {
    const list = await buildProjectList(deps({
      getEntry: (path) => ({
        note: '', pinned: path.endsWith('old'), hidden: false, staleDays: null, lastOpened: null,
      }),
    }));
    expect(list[0].name).toBe('old');
  });
});
