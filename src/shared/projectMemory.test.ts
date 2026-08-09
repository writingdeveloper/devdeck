import { describe, expect, it } from 'vitest';
import { buildProjectMemory, parseRecentCommits, type ProjectMemoryInput } from './projectMemory';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

function input(over: Partial<ProjectMemoryInput> = {}): ProjectMemoryInput {
  return {
    projectPath: 'C:/repo',
    generatedAt: NOW,
    git: {
      branch: 'main', uncommitted: 0, ahead: 0,
      lastCommitMs: NOW - 2_000, lastSubject: 'latest', repoUrl: null,
    },
    commits: [{ hash: 'abc123', at: NOW - 2_000, subject: 'latest' }],
    sessions: [],
    entry: { note: '', pinned: false, hidden: false, lastOpened: null, todos: [] },
    partial: [],
    ...over,
  };
}

describe('parseRecentCommits', () => {
  it('parses delimiter-safe records and skips malformed records', () => {
    const raw = 'abc123\u001f1720000000\u001fsubject | safe\u001eBAD\u001edeadbeef\u001fnope\u001fbad time\u001e';
    expect(parseRecentCommits(raw)).toEqual([
      { hash: 'abc123', at: 1_720_000_000_000, subject: 'subject | safe' },
    ]);
  });

  it('preserves unit separators inside a commit subject', () => {
    expect(parseRecentCommits('abcd\u001f1720000000\u001fone\u001ftwo\u001e')[0]?.subject).toBe('one\u001ftwo');
  });
});

describe('buildProjectMemory', () => {
  it('uses the newest session last message and keeps provider ownership', () => {
    const memory = buildProjectMemory(input({
      sessions: [
        { id: 'new', agentId: 'codex', mtimeMs: NOW - 100, firstMessage: 'start auth', lastUserMessage: 'finish auth tests' },
        { id: 'old', agentId: 'claude', mtimeMs: NOW - 200, firstMessage: 'old work', lastUserMessage: 'old request' },
      ],
    }));
    expect(memory.snapshot.continueFrom).toEqual({
      text: 'finish auth tests', agentId: 'codex', sessionId: 'new', at: NOW - 100,
    });
    expect(memory.events.filter((e) => e.kind === 'session')).toHaveLength(2);
  });

  it('falls back to the newest session first message', () => {
    const memory = buildProjectMemory(input({
      sessions: [{ id: 's1', agentId: 'claude', mtimeMs: NOW - 100, firstMessage: 'begin work', lastUserMessage: null }],
    }));
    expect(memory.snapshot.continueFrom?.text).toBe('begin work');
  });

  it('orders events newest-first with a stable tie break and caps them at 40', () => {
    const todos = Array.from({ length: 45 }, (_, i) => ({
      id: `t${String(i).padStart(2, '0')}`, text: `task ${i}`, done: false, due: null,
      createdAt: new Date(NOW - i * 1000).toISOString(),
    }));
    const memory = buildProjectMemory(input({
      commits: [],
      entry: { note: '', pinned: false, hidden: false, lastOpened: null, todos },
    }));
    expect(memory.events).toHaveLength(40);
    expect(memory.events.map((e) => e.at)).toEqual([...memory.events.map((e) => e.at)].sort((a, b) => b - a));
    expect(memory.events[0]?.id).toBe('task:t00');
  });

  it('orders next tasks by overdue, today, future, then creation and counts the remainder', () => {
    const todos = [
      { id: 'none', text: 'none', done: false, due: null, createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'future', text: 'future', done: false, due: '2026-08-10', createdAt: '2026-08-02T00:00:00.000Z' },
      { id: 'done', text: 'done', done: true, due: '2026-08-01', createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'today', text: 'today', done: false, due: '2026-08-08', createdAt: '2026-08-04T00:00:00.000Z' },
      { id: 'overdue', text: 'overdue', done: false, due: '2026-08-07', createdAt: '2026-08-05T00:00:00.000Z' },
    ];
    const memory = buildProjectMemory(input({
      entry: { note: 'remember this', pinned: false, hidden: false, lastOpened: new Date(NOW - 500).toISOString(), todos },
    }));
    expect(memory.snapshot.nextTasks.map((t) => t.id)).toEqual(['overdue', 'today', 'future']);
    expect(memory.snapshot.remainingTaskCount).toBe(1);
    expect(memory.snapshot.note).toBe('remember this');
    expect(memory.events.some((e) => e.kind === 'project-opened')).toBe(true);
  });

  it('preserves source failures without discarding available facts', () => {
    const memory = buildProjectMemory(input({ partial: ['sessions'] }));
    expect(memory.partial).toEqual(['sessions']);
    expect(memory.events).toEqual([{ id: 'commit:abc123', kind: 'commit', at: NOW - 2_000, hash: 'abc123', subject: 'latest' }]);
  });
});
