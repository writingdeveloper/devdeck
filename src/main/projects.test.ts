import { describe, it, expect } from 'vitest';
import { buildProjectList, type BuildDeps } from './projects';
import type { GitInfo, SessionMeta } from '../shared/types';
import { DEFAULT_THRESHOLDS } from '../shared/staleness';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function deps(over: Partial<BuildDeps>): BuildDeps {
  return {
    nowMs: NOW,
    thresholds: DEFAULT_THRESHOLDS,
    scan: async () => [
      { path: 'C:\\g\\fresh', name: 'fresh' },
      { path: 'C:\\g\\old', name: 'old' },
    ],
    git: async (dir): Promise<GitInfo> => ({
      branch: 'main',
      lastCommitMs: dir.endsWith('fresh') ? NOW - 3_600_000 : NOW - 10 * DAY,
      lastSubject: 'x',
      uncommitted: 0,
      ahead: null,
      repoUrl: null,
    }),
    sessions: async () => [],
    resumeCue: async () => null,
    getEntry: () => ({ note: '', pinned: false, hidden: false, lastOpened: null, todos: [] }),
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

  it('includes hidden projects in output (renderer filters them)', async () => {
    const list = await buildProjectList(deps({
      getEntry: (path) => ({
        note: '', pinned: false, hidden: path.endsWith('old'), lastOpened: null, todos: [],
      }),
    }));
    expect(list.map((p) => p.name)).toEqual(['fresh', 'old']);
    expect(list.find((p) => p.name === 'old')!.hidden).toBe(true);
    expect(list.find((p) => p.name === 'fresh')!.hidden).toBe(false);
  });

  it('floats pinned projects to the top regardless of activity', async () => {
    const list = await buildProjectList(deps({
      getEntry: (path) => ({
        note: '', pinned: path.endsWith('old'), hidden: false, lastOpened: null, todos: [],
      }),
    }));
    expect(list[0].name).toBe('old');
  });

  it('wires sessions + sessionCount and uses the latest session for activity', async () => {
    const NOW2 = NOW;
    const list = await buildProjectList(deps({
      git: async (): Promise<GitInfo> => ({ branch: 'main', lastCommitMs: null, lastSubject: null, uncommitted: 0, ahead: 4, repoUrl: 'https://github.com/acme/proj' }),
      sessions: async (p) => p.endsWith('fresh')
        ? [{ id: 'x', mtimeMs: NOW2 - 3_600_000, firstMessage: 'hi' }]
        : [],
    }));
    const fresh = list.find((p) => p.name === 'fresh')!;
    expect(fresh.sessionCount).toBe(1);
    expect(fresh.sessions[0].firstMessage).toBe('hi');
    expect(fresh.lastSessionMs).toBe(NOW2 - 3_600_000);
    expect(fresh.stale.level).toBe('fresh');
    expect(fresh.ahead).toBe(4); // unpushed count threaded through
    expect(fresh.repoUrl).toBe('https://github.com/acme/proj'); // github remote threaded through
  });

  it('derives resumeCue from the newest session via the dep', async () => {
    const list = await buildProjectList(deps({
      sessions: async (p) => p.endsWith('fresh')
        ? [{ id: 'newest', mtimeMs: NOW, firstMessage: 'hi' }]
        : [],
      resumeCue: async (_p, sessionId) => (sessionId === 'newest' ? 'continue the cue work' : null),
    }));
    expect(list.find((p) => p.name === 'fresh')!.resumeCue).toEqual({ kind: 'lastMessage', text: 'continue the cue work' });
    expect(list.find((p) => p.name === 'old')!.resumeCue).toBeNull();
  });
});
