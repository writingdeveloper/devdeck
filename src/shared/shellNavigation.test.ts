import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  buildSessionGroups,
  filterShellItems,
  normalizeCollapsedGroups,
  normalizeSidebarState,
  restoreShellContext,
  sessionAccessibleLabel,
  sessionActionsFor,
  sessionStatusCounts,
  sessionStatusShape,
  shellEntityKey,
  toggleCollapsedGroup,
  truncateList,
  unpinDestination,
  type ShellGroupKind,
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

  // Alphabetical order was what forced the user into "a pin for the pins": with the pinned group
  // sorted by name, the session they touched a minute ago had no way to surface.
  it('orders every group by last activity, newest first', () => {
    const pinned = (id: string, lastActiveMs: number | null): ShellSessionInput =>
      ({ id, projectPath: `C:/${id}`, label: id, detail: 'main', activity: 'idle', pinned: true, lastActiveMs });
    const groups = buildSessionGroups([pinned('alpha', 1_000), pinned('zulu', 9_000), pinned('mike', 5_000)]);
    expect(groups[0].items.map((item) => item.id)).toEqual(['zulu', 'mike', 'alpha']);
  });

  it('sorts never-observed sessions last (by name), never above a timestamped one', () => {
    const pinned = (id: string, lastActiveMs?: number | null): ShellSessionInput =>
      ({ id, projectPath: `C:/${id}`, label: id, detail: 'main', activity: 'idle', pinned: true, lastActiveMs });
    // 'aaa'/'bbb' predate the persisted timestamp — they must not win the top slot on name alone.
    const groups = buildSessionGroups([pinned('bbb'), pinned('zzz', 1), pinned('aaa', null)]);
    expect(groups[0].items.map((item) => item.id)).toEqual(['zzz', 'aaa', 'bbb']);
  });

  it('names the group an unpin would move the row into (so the toast can say where it went)', () => {
    const base: ShellSessionInput = { id: 'x', projectPath: 'C:/x', label: 'x', detail: 'main', activity: 'idle', pinned: true };
    expect(unpinDestination(base)).toBe('quiet');
    expect(unpinDestination({ ...base, activity: 'turn' })).toBe('turn');
    expect(unpinDestination({ ...base, previous: true })).toBe('previous');
    // A row that is loud on its own doesn't move at all — its group never depended on the pin.
    expect(unpinDestination({ ...base, activity: 'attention' })).toBe('attention');
  });

  describe('collapsed group state', () => {
    it('drops unknown kinds and duplicates, and keeps a stable order', () => {
      expect(normalizeCollapsedGroups(['quiet', 'nope', 'quiet', 'attention'])).toEqual(['attention', 'quiet']);
      expect(normalizeCollapsedGroups('quiet')).toEqual([]);
      expect(normalizeCollapsedGroups(null)).toEqual([]);
    });
    it('toggles one kind at a time', () => {
      const start: ShellGroupKind[] = [];
      const folded = toggleCollapsedGroup(start, 'previous');
      expect(folded).toEqual(['previous']);
      expect(toggleCollapsedGroup(folded, 'previous')).toEqual([]);
      expect(toggleCollapsedGroup(folded, 'quiet')).toEqual(['quiet', 'previous']);
    });
  });

  describe('truncateList', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    it('passes a short list through untouched', () => {
      expect(truncateList(items, { limit: 5, expanded: false })).toEqual({ shown: items, hidden: 0 });
    });
    it('cuts to the head and reports the remainder', () => {
      expect(truncateList(items, { limit: 2, expanded: false })).toEqual({ shown: ['a', 'b'], hidden: 3 });
    });
    it('expanded shows everything', () => {
      expect(truncateList(items, { limit: 2, expanded: true })).toEqual({ shown: items, hidden: 0 });
    });
    // A pinned project sitting at position 40 must survive the "recent 8" cut — otherwise pinning it
    // would be the one thing that makes it disappear.
    it('keeps protected items past the cut and excludes them from the hidden count', () => {
      expect(truncateList(items, { limit: 2, expanded: false, keep: (x) => x === 'e' }))
        .toEqual({ shown: ['a', 'b', 'e'], hidden: 2 });
    });
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

  it('accepts only a persisted boolean sidebar state', () => {
    expect(normalizeSidebarState(true)).toBe(true);
    expect(normalizeSidebarState(false)).toBe(false);
    expect(normalizeSidebarState('true')).toBe(false);
    expect(normalizeSidebarState(undefined)).toBe(false);
  });

  it('offers a live session the same pin/rename/close it had in the old cockpit list', () => {
    const liveRow = rows.find((item) => item.id === 'work')!;
    expect(sessionActionsFor(liveRow)).toEqual(['pin', 'rename', 'close']);
    expect(sessionActionsFor({ ...liveRow, pinned: true })).toEqual(['unpin', 'rename', 'close']);
  });

  it('offers a not-yet-restored entry only the actions it can honour', () => {
    const previous: ShellSessionInput = { id: 'old', projectPath: 'C:/old', label: 'old', detail: 'restore', activity: 'idle', pinned: false, previous: true };
    expect(sessionActionsFor(previous)).toEqual(['pin', 'forget']);
    expect(sessionActionsFor({ ...previous, pinned: true })).toEqual(['unpin', 'forget']);
  });

  it('separates every status by shape so activity never rides on color alone', () => {
    const base: ShellSessionInput = { id: 'a', projectPath: 'C:/a', label: 'a', detail: '', activity: 'idle', pinned: false };
    const shapes = (['attention', 'working', 'turn', 'idle', 'exited'] as const)
      .map((activity) => sessionStatusShape({ ...base, activity }));
    expect(shapes).toEqual(['diamond', 'spinner', 'ring', 'dot', 'square']);
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(sessionStatusShape({ ...base, conversationGone: true })).toBe('square');
  });

  it('counts the states a collapsed sidebar still has to report', () => {
    expect(sessionStatusCounts(rows)).toEqual({ attention: 1, working: 1 });
    expect(sessionStatusCounts([])).toEqual({ attention: 0, working: 0 });
  });

  it('uses immutable entity identifiers and exposes session activity to assistive technology', () => {
    const session = { id: 'session-42', projectPath: 'C:/repo', label: 'Review API', detail: 'feature/api · Codex', activity: 'attention', pinned: false } as const;
    expect(shellEntityKey('project', 'C:/repo')).toBe('project:C:/repo');
    expect(shellEntityKey('session', session.id)).toBe('session:session-42');
    expect(sessionAccessibleLabel(session, 'Awaiting you')).toBe('Review API, feature/api · Codex, Awaiting you');
    expect(sessionAccessibleLabel({ ...session, summary: 'Rewriting the auth guard' }, 'Awaiting you'))
      .toBe('Review API, feature/api · Codex, Awaiting you, Rewriting the auth guard');
  });
});
