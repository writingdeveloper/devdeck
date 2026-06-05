import { describe, it, expect } from 'vitest';
import { collectNextItems } from './nextItems';

type Src = Parameters<typeof collectNextItems>[0][number];
const s = (over: Partial<Src> = {}): Src =>
  ({ path: '/p', name: 'p', note: '', resumeCue: null, hidden: false, activityMs: 0, ...over });

describe('collectNextItems', () => {
  it('uses the manual note when present (trimmed)', () => {
    expect(collectNextItems([s({ name: 'a', note: '  fix the bug  ' })]))
      .toEqual([{ path: '/p', name: 'a', text: 'fix the bug', kind: 'note' }]);
  });

  it('falls back to the resume cue when there is no note', () => {
    expect(collectNextItems([s({ name: 'b', resumeCue: { kind: 'lastMessage', text: 'do X' } })]))
      .toEqual([{ path: '/p', name: 'b', text: 'do X', kind: 'cue' }]);
  });

  it('prefers a note over a cue', () => {
    const out = collectNextItems([s({ note: 'note wins', resumeCue: { kind: 'lastMessage', text: 'cue' } })]);
    expect(out[0]).toMatchObject({ text: 'note wins', kind: 'note' });
  });

  it('skips projects with neither, and hidden projects', () => {
    expect(collectNextItems([s({ note: '', resumeCue: null }), s({ hidden: true, note: 'x' })])).toEqual([]);
  });

  it('sorts by activity, most recent first', () => {
    const out = collectNextItems([
      s({ name: 'old', note: 'o', activityMs: 1 }),
      s({ name: 'new', note: 'n', activityMs: 9 }),
    ]);
    expect(out.map((i) => i.name)).toEqual(['new', 'old']);
  });
});
