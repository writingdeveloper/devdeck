import { describe, expect, it } from 'vitest';
import { snapshotRows, timelineRows } from './projectMemoryPresentation';
import type { ProjectMemory } from '../shared/types';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

function memory(over: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    projectPath: 'C:/repo', generatedAt: NOW,
    snapshot: {
      continueFrom: { text: 'continue here', agentId: 'claude', sessionId: '00000000', at: NOW - 100 },
      git: { branch: 'main', uncommitted: 0, ahead: 0, latestCommit: { hash: 'abc123', at: NOW - 200, subject: 'latest' } },
      nextTasks: [], remainingTaskCount: 0, note: null,
    },
    events: [], partial: [],
    ...over,
  };
}

describe('snapshotRows', () => {
  it('omits empty optional rows and labels a clean working tree', () => {
    const rows = snapshotRows(memory(), NOW);
    expect(rows.map((r) => r.kind)).toEqual(['continue', 'working-tree', 'latest-change']);
    expect(rows.find((r) => r.kind === 'working-tree')?.valueKey).toBe('memory.clean');
  });

  it('keeps note and task source text as raw data with an exact task action', () => {
    const m = memory();
    m.snapshot.nextTasks = [{ id: 't1', text: '<b>do not render</b>', done: false, due: '2026-08-09', createdAt: new Date(NOW).toISOString() }];
    m.snapshot.remainingTaskCount = 2;
    m.snapshot.note = '<img src=x onerror=alert(1)>';
    const rows = snapshotRows(m, NOW);
    expect(rows.find((r) => r.kind === 'tasks')).toMatchObject({
      items: ['<b>do not render</b>'], action: { kind: 'tasks' }, count: 3,
    });
    expect(rows.find((r) => r.kind === 'note')?.value).toBe('<img src=x onerror=alert(1)>');
  });

  it('describes dirty and unpushed counts as independent facts', () => {
    const m = memory();
    m.snapshot.git.uncommitted = 3;
    m.snapshot.git.ahead = 2;
    const row = snapshotRows(m, NOW).find((r) => r.kind === 'working-tree');
    expect(row).toMatchObject({ valueKey: 'memory.working_state', vars: { dirty: 3, ahead: 2 } });
  });
});

describe('timelineRows', () => {
  it('keeps hostile source text as data and returns exact session ownership', () => {
    const m = memory({
      events: [{
        id: 'session:claude:00000000', kind: 'session', at: NOW,
        agentId: 'claude', sessionId: '00000000', firstMessage: 'first', lastUserMessage: '<img src=x onerror=alert(1)>',
      }],
    });
    expect(timelineRows(m)[0]).toMatchObject({
      title: '<img src=x onerror=alert(1)>',
      detail: 'first',
      action: { kind: 'session', sessionId: '00000000', agentId: 'claude' },
    });
  });

  it('maps commit, task, and project-open events to their exact actions', () => {
    const m = memory({ events: [
      { id: 'c', kind: 'commit', at: NOW, hash: 'abc123', subject: 'ship it' },
      { id: 't', kind: 'task-created', at: NOW - 1, todoId: 't1', text: 'write tests', done: false, due: null },
      { id: 'o', kind: 'project-opened', at: NOW - 2 },
    ] });
    expect(timelineRows(m).map((r) => r.action)).toEqual([
      { kind: 'copy', text: 'abc123' }, { kind: 'tasks' }, null,
    ]);
  });
});
