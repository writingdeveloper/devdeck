import { describe, expect, it } from 'vitest';
import { makeProjectMemoryService, type ProjectMemoryDeps } from './projectMemory';
import type { GitInfo, ProjectSession, StoreEntry } from '../shared/types';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const GIT: GitInfo = { branch: 'main', uncommitted: 0, ahead: 0, lastCommitMs: NOW - 1000, lastSubject: 'latest', repoUrl: null };
const ENTRY: StoreEntry = { note: 'next', pinned: false, hidden: false, lastOpened: null, todos: [] };

function deps(over: Partial<ProjectMemoryDeps> = {}): ProjectMemoryDeps {
  return {
    now: () => NOW,
    gitInfo: async () => GIT,
    commits: async () => [{ hash: 'abc123', at: NOW - 1000, subject: 'latest' }],
    sessions: async () => [],
    lastUserMessage: async () => null,
    entry: () => ENTRY,
    ...over,
  };
}

describe('makeProjectMemoryService', () => {
  it('shares an in-flight cache hit and refreshes only the requested project', async () => {
    const counts = new Map<string, number>();
    const service = makeProjectMemoryService(deps({
      gitInfo: async (path) => {
        counts.set(path, (counts.get(path) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return GIT;
      },
    }));
    const first = service.get('C:/a');
    const same = service.get('c:\\a\\');
    expect(same).toBe(first);
    await Promise.all([first, same]);
    await service.get('C:/b');
    await service.get('C:/a', true);
    expect(counts.get('C:/a')).toBe(2);
    expect(counts.get('C:/b')).toBe(1);
  });

  it('limits last-message reads to three concurrent operations', async () => {
    let inFlight = 0, maxInFlight = 0;
    const sessions: ProjectSession[] = Array.from({ length: 7 }, (_, i) => ({
      id: `0000000${i}`, agentId: i % 2 ? 'codex' : 'claude', mtimeMs: NOW - i, firstMessage: `first ${i}`,
    }));
    const service = makeProjectMemoryService(deps({
      sessions: async (_path, limit) => sessions.slice(0, limit),
      lastUserMessage: async (_path, session) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return `last ${session.id}`;
      },
    }));
    const result = await service.get('C:/a');
    expect(maxInFlight).toBe(3);
    expect(result.snapshot.continueFrom?.text).toBe('last 00000000');
    expect(result.events.filter((e) => e.kind === 'session')).toHaveLength(7);
  });

  it('marks failed sources partial while keeping store and successful session facts', async () => {
    const service = makeProjectMemoryService(deps({
      gitInfo: async () => { throw new Error('gone'); },
      commits: async () => { throw new Error('gone'); },
      sessions: async () => [{ id: '00000000', agentId: 'claude', mtimeMs: NOW, firstMessage: 'start' }],
    }));
    const result = await service.get('C:/a');
    expect(result.partial).toEqual(['git']);
    expect(result.snapshot.note).toBe('next');
    expect(result.events.some((e) => e.kind === 'session')).toBe(true);
  });

  it('marks session discovery failure without hiding Git history', async () => {
    const service = makeProjectMemoryService(deps({ sessions: async () => { throw new Error('sessions unavailable'); } }));
    const result = await service.get('C:/a');
    expect(result.partial).toEqual(['sessions']);
    expect(result.events.some((e) => e.kind === 'commit')).toBe(true);
  });
});
