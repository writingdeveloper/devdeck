import { describe, it, expect } from 'vitest';
import { filterSessions, groupByActivity, needsAttentionCount, isCockpitPlatform, type CockpitSession } from './cockpitModel';

const s = (over: Partial<CockpitSession> = {}): CockpitSession => ({
  id: 'p#1', projectPath: 'C:\\g\\proj', name: 'proj', agentId: 'claude',
  status: 'running', staleLevel: 'fresh', branch: 'main', dirty: 0, activity: 'working', ...over,
});

describe('filterSessions', () => {
  it('matches name and branch case-insensitively', () => {
    const list = [s({ id: 'a', name: 'devdeck' }), s({ id: 'b', name: 'api', branch: 'feat/auth' })];
    expect(filterSessions(list, 'DEV').map((x) => x.id)).toEqual(['a']);
    expect(filterSessions(list, 'auth').map((x) => x.id)).toEqual(['b']);
    expect(filterSessions(list, '').map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('handles a null branch without throwing', () => {
    const list = [s({ id: 'a', name: 'devdeck', branch: null })];
    expect(filterSessions(list, 'dev').map((x) => x.id)).toEqual(['a']);
    expect(filterSessions(list, 'nomatch')).toEqual([]);
  });
});

describe('groupByActivity', () => {
  it('buckets + orders: attention/turn => attention bucket, working => working, idle/exited => idle; attention before turn', () => {
    const list = [
      s({ id: 'w', name: 'w', activity: 'working' }),
      s({ id: 'e', name: 'e', activity: 'exited' }),
      s({ id: 't', name: 't', activity: 'turn' }),
      s({ id: 'a', name: 'a', activity: 'attention' }),
      s({ id: 'i', name: 'i', activity: 'idle' }),
    ];
    const g = groupByActivity(list);
    expect(g.map((x) => x.bucket)).toEqual(['attention', 'working', 'turn', 'idle']);
    expect(g[0].items.map((x) => x.id)).toEqual(['a']);
    expect(g[1].items.map((x) => x.id)).toEqual(['w']);
    expect(g[2].items.map((x) => x.id)).toEqual(['t']); // 'turn' is its own "Your turn" group
    expect(g[3].items.map((x) => x.id)).toEqual(['i', 'e']); // idle before exited
  });
  it('omits empty buckets', () => {
    expect(groupByActivity([s({ activity: 'working' })]).map((x) => x.bucket)).toEqual(['working']);
  });
});

describe('needsAttentionCount', () => {
  it('counts only attention (a question) — not turn / typing', () => {
    const list = [s({ activity: 'attention' }), s({ activity: 'turn' }), s({ activity: 'working' }), s({ activity: 'idle' })];
    expect(needsAttentionCount(list)).toBe(1);
  });
});

describe('isCockpitPlatform', () => {
  it('is true only on win32', () => {
    expect(isCockpitPlatform('win32')).toBe(true);
    expect(isCockpitPlatform('darwin')).toBe(false);
    expect(isCockpitPlatform('linux')).toBe(false);
  });
});
