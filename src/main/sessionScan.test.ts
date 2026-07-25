import { describe, expect, it } from 'vitest';
import { makeProjectSessionScan, mergeProjectSessions, providerOrderFromSessions } from './sessionScan';
import type { SessionMeta } from '../shared/types';

const s = (id: string, mtimeMs: number): SessionMeta => ({ id, mtimeMs, firstMessage: null });

describe('mergeProjectSessions', () => {
  it('tags every session with its owning provider and orders newest-first across providers', () => {
    const merged = mergeProjectSessions([
      { agentId: 'claude', sessions: [s('c1', 300), s('c2', 100)] },
      { agentId: 'codex', sessions: [s('x1', 200)] },
    ], 5);
    expect(merged.map((m) => [m.id, m.agentId])).toEqual([['c1', 'claude'], ['x1', 'codex'], ['c2', 'claude']]);
  });

  it('caps the merged list', () => {
    const merged = mergeProjectSessions([{ agentId: 'claude', sessions: [s('a', 3), s('b', 2), s('c', 1)] }], 2);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('providerOrderFromSessions', () => {
  it('lists each provider once, newest session first', () => {
    const order = providerOrderFromSessions([
      { ...s('x', 3), agentId: 'codex' }, { ...s('y', 2), agentId: 'claude' }, { ...s('z', 1), agentId: 'codex' },
    ]);
    expect(order).toEqual(['codex', 'claude']);
  });

  it('is empty for a project with no history', () => {
    expect(providerOrderFromSessions([])).toEqual([]);
  });
});

describe('makeProjectSessionScan', () => {
  it('aggregates per-project and indexed providers for one project', async () => {
    const scan = makeProjectSessionScan({
      installed: ['claude', 'codex'],
      perProject: { claude: async () => [s('c1', 100)] },
      indexed: { codex: () => new Map([['c:\\g\\proj', [s('x1', 200)]]]) },
    });
    const out = await scan.sessions('C:\\g\\proj');
    expect(out.map((o) => [o.id, o.agentId])).toEqual([['x1', 'codex'], ['c1', 'claude']]);
  });

  it('matches an indexed cwd spelled with other separators / drive case', async () => {
    const scan = makeProjectSessionScan({
      installed: ['codex'], perProject: {},
      indexed: { codex: () => new Map([['c:\\g\\proj', [s('x1', 200)]]]) },
    });
    expect((await scan.sessions('C:/g/proj/')).map((o) => o.id)).toEqual(['x1']);
  });

  it('skips providers that are not installed', async () => {
    const scan = makeProjectSessionScan({
      installed: ['claude'],
      perProject: { claude: async () => [s('c1', 100)] },
      indexed: { codex: () => { throw new Error('must not be indexed'); } },
    });
    expect((await scan.sessions('C:\\g\\proj')).map((o) => o.agentId)).toEqual(['claude']);
  });

  it('builds each flat-store index ONCE per scan, however many projects ask', async () => {
    let builds = 0;
    const scan = makeProjectSessionScan({
      installed: ['codex'], perProject: {},
      indexed: { codex: () => { builds++; return new Map([['c:\\g\\a', [s('x1', 1)]]]); } },
    });
    await scan.sessions('C:\\g\\a');
    await scan.sessions('C:\\g\\b');
    await scan.sessions('C:\\g\\c');
    expect(builds).toBe(1);
  });

  it('contains a provider failure instead of blanking the project', async () => {
    const scan = makeProjectSessionScan({
      installed: ['claude', 'codex'],
      perProject: { claude: async () => { throw new Error('unreadable'); } },
      indexed: { codex: () => new Map([['c:\\g\\proj', [s('x1', 200)]]]) },
    });
    expect((await scan.sessions('C:\\g\\proj')).map((o) => o.id)).toEqual(['x1']);
  });

  it('contains an index build failure (corrupt store) the same way', async () => {
    const scan = makeProjectSessionScan({
      installed: ['claude', 'codex'],
      perProject: { claude: async () => [s('c1', 100)] },
      indexed: { codex: () => { throw new Error('corrupt store'); } },
    });
    expect((await scan.sessions('C:\\g\\proj')).map((o) => o.id)).toEqual(['c1']);
  });
});
