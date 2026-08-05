import { describe, it, expect } from 'vitest';
import { sanitizePersistedList, pickRestoreSessionId, resolveRestoreTarget, adoptRestorableMatch, pickDriftedSessionId, pickAdoptedSessionId, type PersistedSession, type SessionFileStat } from './cockpitPersist';

describe('sanitizePersistedList', () => {
  it('returns [] for non-arrays', () => {
    expect(sanitizePersistedList(null)).toEqual([]);
    expect(sanitizePersistedList({})).toEqual([]);
    expect(sanitizePersistedList('x')).toEqual([]);
  });

  it('keeps valid provider entries verbatim (label defaults to null)', () => {
    const r = sanitizePersistedList([
      { projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity' },
      { projectPath: 'C:/a/c', name: 'c', sessionId: 's2', agentId: 'codex' },
    ]);
    expect(r).toEqual([
      { projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity', label: null },
      { projectPath: 'C:/a/c', name: 'c', sessionId: 's2', agentId: 'codex', label: null },
    ]);
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

  it('coerces sessionId to string|null and unknown agentId to claude', () => {
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
  // Taking a conversation another saved entry is waiting for makes the open CONSUME that entry
  // (adoptRestorableMatch), so its user-given name disappears with it.
  it('prefers a conversation no other saved entry is waiting to restore', () => {
    expect(pickRestoreSessionId(['new', 'mid', 'old'], new Set(), new Set(['new']))).toBe('mid');
    expect(pickRestoreSessionId(['new', 'mid', 'old'], new Set(['mid']), new Set(['new']))).toBe('old');
  });
  it('still restores something when every free conversation is reserved (preference, not a rule)', () => {
    expect(pickRestoreSessionId(['new', 'mid'], new Set(), new Set(['new', 'mid']))).toBe('new');
  });
});

describe('pickDriftedSessionId', () => {
  // A live tile's conversation MOVES to a brand-new session id when the user runs /clear (Claude
  // starts a new .jsonl in the same terminal). The open-time id then goes permanently stale, and a
  // restart restores the PAST conversation — the "재시작 후 과거 데이터" bug. This detector adopts the
  // new id only on unambiguous evidence; every ambiguous case must return null (keep the current id).
  const T = 1_000_000_000; // base "now"
  const stat = (id: string, mtimeMs: number, birthtimeMs: number): SessionFileStat => ({ id, mtimeMs, birthtimeMs });
  // Typical /clear at T-5s: tile opened at T-60s on X (born long ago, last written T-20s);
  // Y was created by /clear and is being written now. Last drift check was at T-30s.
  const base = { currentId: 'X', claimedIds: [] as string[], openedAtMs: T - 60_000, sinceMs: T - 30_000, lastDataAtMs: T - 1_000 };
  const oldX = stat('X', T - 40_000, T - 300_000); // current file quiet since before the last check
  const hotY = stat('Y', T - 2_000, T - 5_000);    // born after the tile opened, written just now

  it('adopts the single unclaimed newborn file when the tile streamed but its own file did not move (/clear)', () => {
    expect(pickDriftedSessionId([oldX, hotY], base)).toBe('Y');
  });
  it('keeps the current id while its own file is still being written (no drift)', () => {
    expect(pickDriftedSessionId([stat('X', T - 1_500, T - 300_000), hotY], base)).toBeNull();
  });
  it('ignores files claimed by another live tile (same-project siblings stay distinct)', () => {
    expect(pickDriftedSessionId([oldX, hotY], { ...base, claimedIds: ['Y'] })).toBeNull();
  });
  it('ignores files born before the tile opened (an old conversation written by an external terminal)', () => {
    const external = stat('E', T - 2_000, T - 90_000); // hot, but predates this tile
    expect(pickDriftedSessionId([oldX, external], base)).toBeNull();
  });
  it('ambiguous — two hot newborn candidates → keep the current id (resolve on a later sample)', () => {
    const hotZ = stat('Z', T - 2_500, T - 6_000);
    expect(pickDriftedSessionId([oldX, hotY, hotZ], base)).toBeNull();
  });
  it('requires the candidate mtime to track the tile output time (uncoupled writes are not ours)', () => {
    const drifted = stat('Y', T - 2_000, T - 5_000);
    expect(pickDriftedSessionId([oldX, drifted], { ...base, lastDataAtMs: T - 25_000 })).toBeNull();
  });
  it('ignores files not written since the last check', () => {
    const stale = stat('Y', T - 31_000, T - 40_000);
    expect(pickDriftedSessionId([oldX, stale], base)).toBeNull();
  });
  it('no tile output since the last check → nothing can have moved on our behalf', () => {
    expect(pickDriftedSessionId([oldX, hotY], { ...base, lastDataAtMs: T - 31_000 })).toBeNull();
  });
  it('a missing current file (fresh pinned id not yet written) still adopts an unambiguous newborn', () => {
    expect(pickDriftedSessionId([hotY], base)).toBe('Y');
  });
  it('never adopts the current id itself', () => {
    expect(pickDriftedSessionId([stat('X', T - 2_000, T - 5_000)], { ...base, sinceMs: T - 30_000 })).toBeNull();
  });
});

describe('pickAdoptedSessionId', () => {
  // After a tile's provider is re-detected (the user ran a different agent in the tile's shell), the
  // tile has NO id: the old one named a conversation in the old provider's store. Birth time can't gate
  // here — `claude -c` continues a file born long before the tile opened — so coupling + uniqueness do.
  const T = 1_000_000_000;
  const stat = (id: string, mtimeMs: number, birthtimeMs: number): SessionFileStat => ({ id, mtimeMs, birthtimeMs });
  const base = { claimedIds: [] as string[], sinceMs: T - 30_000, lastDataAtMs: T - 1_000 };

  it('adopts a continued conversation born long before the tile opened', () => {
    expect(pickAdoptedSessionId([stat('C', T - 2_000, T - 900_000)], base)).toBe('C');
  });
  it('adopts a brand-new conversation too', () => {
    expect(pickAdoptedSessionId([stat('N', T - 2_000, T - 4_000)], base)).toBe('N');
  });
  it('ignores files claimed by another live tile', () => {
    expect(pickAdoptedSessionId([stat('C', T - 2_000, T - 900_000)], { ...base, claimedIds: ['C'] })).toBeNull();
  });
  it('ignores an uncoupled writer (a session streaming in an external terminal)', () => {
    expect(pickAdoptedSessionId([stat('E', T - 25_000, T - 900_000)], base)).toBeNull();
  });
  it('ambiguous — two coupled candidates → adopt nothing', () => {
    expect(pickAdoptedSessionId([stat('A', T - 2_000, T - 9_000), stat('B', T - 2_500, T - 8_000)], base)).toBeNull();
  });
  it('no tile output since the last check → nothing was written on our behalf', () => {
    expect(pickAdoptedSessionId([stat('C', T - 2_000, T - 900_000)], { ...base, lastDataAtMs: T - 31_000 })).toBeNull();
  });
});

describe('resolveRestoreTarget', () => {
  // The tile's OWN conversation is what "restore this session" should reopen — so distinct topics keep
  // distinct tiles (fixes: a 3rd tile collapsing onto the 2 newest). And when that conversation can't
  // be reopened, the tile gets a BRAND-NEW one rather than a stranger's: the entry carries the user's
  // label + pin, so a substitute puts their name on work they never did.
  const disk = ['new', 'mid', 'homepage', 'old']; // newest-first, all on disk
  const saved = (sessionId: string | null, label: string | null = null, agentId = 'claude') => ({ sessionId, label, agentId });

  it('reopens the saved id when it still exists on disk and is not already live', () => {
    expect(resolveRestoreTarget(saved('homepage'), disk, new Set())).toEqual({ sessionId: 'homepage', fresh: false });
    expect(resolveRestoreTarget(saved('old'), disk, new Set(['new']))).toEqual({ sessionId: 'old', fresh: false }); // not the newest — its own
  });
  // Claude Code deletes transcripts after cleanupPeriodDays, and a session the user never typed in was
  // never written at all — both leave a named entry pointing at nothing.
  it('opens a FRESH session when the saved conversation is gone from disk — never a substitute', () => {
    expect(resolveRestoreTarget(saved('gone'), disk, new Set())).toEqual({ sessionId: null, fresh: true });
    expect(resolveRestoreTarget(saved('gone'), [], new Set())).toEqual({ sessionId: null, fresh: true });
  });
  it('opens a fresh session when the saved id is already open in another tile', () => {
    expect(resolveRestoreTarget(saved('homepage'), disk, new Set(['homepage']))).toEqual({ sessionId: null, fresh: true });
  });
  it('never takes a conversation reserved by another saved entry', () => {
    expect(resolveRestoreTarget(saved('gone'), disk, new Set(), new Set(['new']))).toEqual({ sessionId: null, fresh: true });
  });
  // An id-less entry claims nothing beyond "a session in this project" — unless the user typed a name
  // for it, which is a claim about specific work.
  it('an unnamed id-less entry → newest not-live, reserved last', () => {
    expect(resolveRestoreTarget(saved(null), disk, new Set())).toEqual({ sessionId: 'new', fresh: false });
    expect(resolveRestoreTarget(saved(null), disk, new Set(['new']))).toEqual({ sessionId: 'mid', fresh: false });
    expect(resolveRestoreTarget(saved(null), disk, new Set(), new Set(['new']))).toEqual({ sessionId: 'mid', fresh: false });
  });
  it('a NAMED id-less claude/codex entry comes back fresh — its tile never wrote a conversation', () => {
    expect(resolveRestoreTarget(saved(null, '릴리스 준비'), disk, new Set())).toEqual({ sessionId: null, fresh: true });
    expect(resolveRestoreTarget(saved(null, '릴리스 준비', 'codex'), disk, new Set())).toEqual({ sessionId: null, fresh: true });
  });
  // Antigravity records no id for ANY tile, so an absent one says nothing — the guess is its only resume.
  it('a named Antigravity entry keeps the newest-not-live fallback', () => {
    expect(resolveRestoreTarget(saved(null, '리팩터링', 'antigravity'), disk, new Set())).toEqual({ sessionId: 'new', fresh: false });
  });
  it('an unnamed id-less entry with nothing on disk falls through to the main process (continue/new)', () => {
    expect(resolveRestoreTarget(saved(null), [], new Set())).toEqual({ sessionId: null, fresh: false });
  });
});
