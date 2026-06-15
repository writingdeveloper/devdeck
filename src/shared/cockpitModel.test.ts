import { describe, it, expect } from 'vitest';
import { filterSessions, sortSessions, groupSessions, isCockpitPlatform, type CockpitSession } from './cockpitModel';

const s = (over: Partial<CockpitSession> = {}): CockpitSession => ({
  id: 'p#1', projectPath: 'C:\\g\\proj', name: 'proj', agentId: 'claude',
  status: 'running', staleLevel: 'fresh', branch: 'main', dirty: 0, ...over,
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

describe('sortSessions', () => {
  it('running before exited, then by name', () => {
    // 'mid' is listed before 'alpha' so a rank-only sort would leave them out of order.
    const list = [s({ id: 'z', name: 'zeta', status: 'exited' }), s({ id: 'm', name: 'mid', status: 'running' }), s({ id: 'a', name: 'alpha', status: 'running' })];
    expect(sortSessions(list).map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('groupSessions', () => {
  it('orders running then exited and omits empty groups', () => {
    const list = [s({ id: 'a', status: 'running' }), s({ id: 'b', status: 'exited' })];
    expect(groupSessions(list).map((g) => g.status)).toEqual(['running', 'exited']);
    expect(groupSessions(list).map((g) => g.items.map((i) => i.id))).toEqual([['a'], ['b']]);
    const onlyRunning = [s({ id: 'a', status: 'running' })];
    expect(groupSessions(onlyRunning).map((g) => g.status)).toEqual(['running']);
  });
});

describe('isCockpitPlatform', () => {
  it('is true only on win32', () => {
    expect(isCockpitPlatform('win32')).toBe(true);
    expect(isCockpitPlatform('darwin')).toBe(false);
    expect(isCockpitPlatform('linux')).toBe(false);
  });
});
