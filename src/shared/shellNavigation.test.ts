import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  buildSessionGroups,
  filterShellItems,
  restoreShellContext,
  type ShellSessionInput,
} from './shellNavigation';

const rows: ShellSessionInput[] = [
  { id: 'quiet', projectPath: 'C:/quiet', label: 'quiet', detail: 'main', activity: 'idle', pinned: true },
  { id: 'work', projectPath: 'C:/work', label: 'work', detail: 'feat', activity: 'working', pinned: false },
  { id: 'ask', projectPath: 'C:/ask', label: 'ask', detail: 'main', activity: 'attention', pinned: false },
];

describe('shell navigation', () => {
  it('orders urgent groups before pins and counts only genuine attention', () => {
    expect(buildSessionGroups(rows).map((group) => group.kind)).toEqual(['attention', 'working', 'pinned']);
    expect(attentionCount(rows)).toBe(1);
  });

  it('does not duplicate a pinned attention session in the pinned group', () => {
    const groups = buildSessionGroups([
      { id: 'ask', projectPath: 'C:/ask', label: 'ask', detail: 'main', activity: 'attention', pinned: true },
    ]);
    expect(groups.map((group) => [group.kind, group.items.map((item) => item.id)])).toEqual([
      ['attention', ['ask']],
    ]);
  });

  it('restores a valid context and falls back to projects for missing state', () => {
    expect(restoreShellContext({ kind: 'session', id: 'ask' }, new Set(['C:/ask']), new Set(['ask']))).toEqual({ kind: 'session', id: 'ask' });
    expect(restoreShellContext({ kind: 'session', id: 'gone' }, new Set(['C:/ask']), new Set(['ask']))).toEqual({ kind: 'view', id: 'projects' });
  });

  it('quick-open matches visible labels, details, and project names case-insensitively', () => {
    const projects = [{ path: 'C:/checkout', name: 'checkout-api', branch: 'main' }];
    expect(filterShellItems('CHECKOUT', rows, projects)).toEqual({ sessions: [], projects });
    expect(filterShellItems('FEAT', rows, projects).sessions.map((item) => item.id)).toEqual(['work']);
  });
});
