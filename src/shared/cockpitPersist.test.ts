import { describe, it, expect } from 'vitest';
import { sanitizePersistedList, pickRestoreSessionId, adoptRestorableMatch, type PersistedSession } from './cockpitPersist';

describe('sanitizePersistedList', () => {
  it('returns [] for non-arrays', () => {
    expect(sanitizePersistedList(null)).toEqual([]);
    expect(sanitizePersistedList({})).toEqual([]);
    expect(sanitizePersistedList('x')).toEqual([]);
  });

  it('keeps valid entries verbatim (label defaults to null)', () => {
    const r = sanitizePersistedList([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity' }]);
    expect(r).toEqual([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity', label: null }]);
  });

  it('keeps, trims, and caps a custom label; coerces empty/non-string to null', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: '  auth refactor  ' }])[0].label).toBe('auth refactor');
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: 'x'.repeat(80) }])[0].label).toHaveLength(60);
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: '   ' }])[0].label).toBeNull();
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: 42 }])[0].label).toBeNull();
  });

  it('drops entries without a string projectPath', () => {
    const r = sanitizePersistedList([{ name: 'x' }, { projectPath: '' }, { projectPath: 42 }, { projectPath: 'C:/ok' }]);
    expect(r.map((e) => e.projectPath)).toEqual(['C:/ok']);
  });

  it('defaults name to the path basename', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck' }])[0].name).toBe('devdeck');
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck/' }])[0].name).toBe('devdeck');
  });

  it('coerces sessionId to string|null and agentId to claude/antigravity', () => {
    const r = sanitizePersistedList([
      { projectPath: 'C:/a', sessionId: 123 },
      { projectPath: 'C:/b', sessionId: 'sid', agentId: 'antigravity' },
      { projectPath: 'C:/c', agentId: 'weird' },
    ]);
    expect(r[0]).toMatchObject({ sessionId: null, agentId: 'claude' });
    expect(r[1]).toMatchObject({ sessionId: 'sid', agentId: 'antigravity' });
    expect(r[2]).toMatchObject({ agentId: 'claude' });
  });

  it('coerces pinned to a strict boolean (absent/junk → falsy, only true stays true)', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/a', pinned: true }])[0].pinned).toBe(true);
    expect(sanitizePersistedList([{ projectPath: 'C:/b', pinned: 'yes' }])[0].pinned).toBeFalsy();
    expect(sanitizePersistedList([{ projectPath: 'C:/c' }])[0].pinned).toBeFalsy();
  });

  it('caps at 50 entries', () => {
    const big = Array.from({ length: 80 }, (_v, i) => ({ projectPath: `C:/p${i}` }));
    expect(sanitizePersistedList(big).length).toBe(50);
  });
});

describe('adoptRestorableMatch', () => {
  // Opening a session onto a conversation that a saved entry already points at CONSUMES that entry —
  // its user-given pin + label must carry over, or a deck-open / ⟳ restart silently erases them
  // (the "핀이 재시작 후 사라짐" bug: state.json still had pinned:true, the open path dropped it).
  const entry = (over: Partial<PersistedSession> = {}): PersistedSession =>
    ({ projectPath: 'C:/p', name: 'p', sessionId: 's1', agentId: 'claude', label: null, ...over });

  it('inherits pin + label from the consumed entry when the request carries none (deck open)', () => {
    const r = adoptRestorableMatch([entry({ pinned: true, label: 'auth work' })], 's1', { label: null, pinned: false });
    expect(r).toMatchObject({ label: 'auth work', pinned: true });
    expect(r.rest).toEqual([]); // entry consumed
  });

  it('an explicit request wins over the consumed entry', () => {
    const r = adoptRestorableMatch([entry({ pinned: true, label: 'old' })], 's1', { label: 'new', pinned: true });
    expect(r).toMatchObject({ label: 'new', pinned: true });
  });

  it('leaves non-matching entries untouched and keeps the request values', () => {
    const other = entry({ sessionId: 's2', pinned: true });
    const r = adoptRestorableMatch([other], 's1', { label: null, pinned: false });
    expect(r).toMatchObject({ label: null, pinned: false });
    expect(r.rest).toEqual([other]);
  });

  it('null sessionId adopts nothing and removes nothing', () => {
    const list = [entry({ sessionId: null, pinned: true })];
    const r = adoptRestorableMatch(list, null, { label: null, pinned: false });
    expect(r.rest).toEqual(list);
    expect(r.pinned).toBe(false);
  });
});

describe('pickRestoreSessionId', () => {
  // Restore must land on the project's NEWEST conversation, not a stale pinned id — and when a
  // project has several tiles, each must get a DISTINCT recent session (dedup vs already-live ids).
  it('picks the newest session id (list is newest-first)', () => {
    expect(pickRestoreSessionId(['new', 'mid', 'old'], new Set())).toBe('new');
  });
  it('skips ids already live in another tile → the next-newest, so same-project tiles stay distinct', () => {
    expect(pickRestoreSessionId(['new', 'mid', 'old'], new Set(['new']))).toBe('mid');
    expect(pickRestoreSessionId(['new', 'mid', 'old'], new Set(['new', 'mid']))).toBe('old');
  });
  it('returns null when there are no sessions, or all are already live (caller falls back to continue/new)', () => {
    expect(pickRestoreSessionId([], new Set())).toBeNull();
    expect(pickRestoreSessionId(['a'], new Set(['a']))).toBeNull();
  });
});
