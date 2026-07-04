import { describe, it, expect } from 'vitest';
import { filterSessions, groupByActivity, needsAttentionCount, isCockpitPlatform, numberCollidingNames, cockpitListSignature, shouldNotifyAttention, type CockpitSession } from './cockpitModel';

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
  it('matches the custom display label — a renamed session must be findable by the name it SHOWS', () => {
    const list = [s({ id: 'a', name: 'devdeck' }), s({ id: 'b', name: 'devdeck' })];
    const labels = new Map([['a', '결제모듈 리팩터링']]);
    expect(filterSessions(list, '결제', labels).map((x) => x.id)).toEqual(['a']);
    expect(filterSessions(list, 'devdeck', labels).map((x) => x.id)).toEqual(['a', 'b']); // folder name still matches
  });
});

describe('shouldNotifyAttention', () => {
  // OS notification fires exactly on the working/turn/idle → attention transition, only when the
  // user isn't already looking at the window, gated by the same setting as the tray alert.
  const base = { prev: 'working' as const, next: 'attention' as const, trayAlert: 'attention' as const, windowFocused: false };
  it('notifies on a fresh transition into attention while the window is unfocused', () => {
    expect(shouldNotifyAttention(base)).toBe(true);
    expect(shouldNotifyAttention({ ...base, trayAlert: 'all' })).toBe(true);
  });
  it('is silent when the alert setting is off', () => {
    expect(shouldNotifyAttention({ ...base, trayAlert: 'off' })).toBe(false);
  });
  it('is silent when the window is focused (the user already sees it)', () => {
    expect(shouldNotifyAttention({ ...base, windowFocused: true })).toBe(false);
  });
  it('is silent when already in attention (no re-notify) or when leaving attention', () => {
    expect(shouldNotifyAttention({ ...base, prev: 'attention' })).toBe(false);
    expect(shouldNotifyAttention({ ...base, prev: 'attention', next: 'turn' as never })).toBe(false);
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

describe('numberCollidingNames', () => {
  it('leaves unique names unchanged', () => {
    expect(numberCollidingNames(['auth refactor', 'devdeck', 'api'])).toEqual(['auth refactor', 'devdeck', 'api']);
  });
  it('appends #N by order to names that collide', () => {
    expect(numberCollidingNames(['devdeck', 'api', 'devdeck'])).toEqual(['devdeck #1', 'api', 'devdeck #2']);
  });
  it('numbers each colliding name group independently', () => {
    expect(numberCollidingNames(['x', 'y', 'x', 'y', 'x'])).toEqual(['x #1', 'y #1', 'x #2', 'y #2', 'x #3']);
  });
});

describe('isCockpitPlatform', () => {
  it('is true only on win32', () => {
    expect(isCockpitPlatform('win32')).toBe(true);
    expect(isCockpitPlatform('darwin')).toBe(false);
    expect(isCockpitPlatform('linux')).toBe(false);
  });
});

describe('cockpitListSignature', () => {
  const row = (over: Partial<Parameters<typeof cockpitListSignature>[0][number]> = {}) =>
    ({ id: 'a', activity: 'working', label: 'devdeck', dirty: 0, branch: 'main', model: 'Opus 4.8', agentId: 'claude', selected: false, pinned: false, ...over });

  it('is stable for identical inputs', () => {
    expect(cockpitListSignature([row()], [], 'ko', '')).toBe(cockpitListSignature([row()], [], 'ko', ''));
  });

  it('changes when any rendered field changes', () => {
    const base = cockpitListSignature([row()], [], 'ko', '');
    expect(cockpitListSignature([row({ activity: 'attention' })], [], 'ko', '')).not.toBe(base); // moves group
    expect(cockpitListSignature([row({ branch: 'dev' })], [], 'ko', '')).not.toBe(base);
    expect(cockpitListSignature([row({ dirty: 1 })], [], 'ko', '')).not.toBe(base);
    expect(cockpitListSignature([row({ model: null })], [], 'ko', '')).not.toBe(base);
    expect(cockpitListSignature([row({ label: 'renamed' })], [], 'ko', '')).not.toBe(base);
    expect(cockpitListSignature([row({ selected: true })], [], 'ko', '')).not.toBe(base);
    expect(cockpitListSignature([row({ pinned: true })], [], 'ko', '')).not.toBe(base); // pin toggle moves it to the top group
    expect(cockpitListSignature([row({ ctx: 82 })], [], 'ko', '')).not.toBe(base); // row context % changed
    expect(cockpitListSignature([row()], [], 'en', '')).not.toBe(base);  // language → tr() text differs
    expect(cockpitListSignature([row()], [], 'ko', 'q')).not.toBe(base); // search filter
    expect(cockpitListSignature([row(), row({ id: 'b' })], [], 'ko', '')).not.toBe(base); // row added
    expect(cockpitListSignature([row()], [{ key: 'p', label: 'old', agentId: 'claude' }], 'ko', '')).not.toBe(base); // prev added
    // A restorable entry's pin renders it in the 고정 group (survives restart) — its flip must rebuild.
    expect(cockpitListSignature([row()], [{ key: 'p', label: 'old', agentId: 'claude', pinned: true }], 'ko', ''))
      .not.toBe(cockpitListSignature([row()], [{ key: 'p', label: 'old', agentId: 'claude', pinned: false }], 'ko', ''));
  });

  it('does not collide when fields shift across the delimiter', () => {
    // "a|b" vs "ab|" must differ — guards against a naive join with no separator.
    expect(cockpitListSignature([row({ id: 'a', label: 'b' })], [], 'ko', ''))
      .not.toBe(cockpitListSignature([row({ id: 'ab', label: '' })], [], 'ko', ''));
  });
});
