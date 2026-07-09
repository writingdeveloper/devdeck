import { describe, it, expect } from 'vitest';
import { projectSignature, diffCards, filterByLive, type SignatureInput, type SignatureUiState } from './deckReconcile';

const baseInput: SignatureInput = {
  stale: { level: 'fresh', ageDays: 0 },
  name: 'devdeck',
  branch: 'main',
  uncommitted: 0,
  ahead: 0,
  lastCommitMs: 1_000,
  lastSubject: 'init',
  lastSessionMs: 2_000,
  sessionCount: 1,
  activityMs: 3_000,
  note: '',
  resumeCue: null,
  repoUrl: 'https://github.com/o/r',
  pinned: false,
  hidden: false,
  todos: [],
};
const baseUi: SignatureUiState = { expanded: false, cost: null, showHidden: false, viewMode: 'cards' };

describe('projectSignature', () => {
  it('returns the same string for identical inputs', () => {
    expect(projectSignature(baseInput, baseUi)).toBe(projectSignature(baseInput, baseUi));
  });

  const dataMutations: [string, (i: SignatureInput) => SignatureInput][] = [
    ['name', (i) => ({ ...i, name: 'other' })],
    ['branch', (i) => ({ ...i, branch: 'dev' })],
    ['branch null', (i) => ({ ...i, branch: null })],
    ['uncommitted', (i) => ({ ...i, uncommitted: 1 })],
    ['ahead', (i) => ({ ...i, ahead: 2 })],
    ['lastCommitMs', (i) => ({ ...i, lastCommitMs: 9_999 })],
    ['lastSubject', (i) => ({ ...i, lastSubject: 'other' })],
    ['lastSubject null', (i) => ({ ...i, lastSubject: null })],
    ['lastSessionMs', (i) => ({ ...i, lastSessionMs: 9_999 })],
    ['sessionCount', (i) => ({ ...i, sessionCount: 2 })],
    ['activityMs', (i) => ({ ...i, activityMs: 9_999 })],
    ['note', (i) => ({ ...i, note: 'todo' })],
    ['resumeCue', (i) => ({ ...i, resumeCue: { text: 'pick up here' } })],
    ['repoUrl null', (i) => ({ ...i, repoUrl: null })],
    ['pinned', (i) => ({ ...i, pinned: true })],
    ['hidden', (i) => ({ ...i, hidden: true })],
    ['stale.level', (i) => ({ ...i, stale: { ...i.stale, level: 'neglected' } })],
    ['stale.ageDays', (i) => ({ ...i, stale: { ...i.stale, ageDays: 5 } })],
    ['todos add', (i) => ({ ...i, todos: [{ id: 'a', done: false, due: null }] })],
    ['todos done', (i) => ({ ...i, todos: [{ id: 'a', done: true, due: null }] })],
    ['todos due', (i) => ({ ...i, todos: [{ id: 'a', done: false, due: '2026-07-04' }] })],
  ];
  for (const [label, mut] of dataMutations) {
    it(`changes when ${label} changes`, () => {
      expect(projectSignature(mut(baseInput), baseUi)).not.toBe(projectSignature(baseInput, baseUi));
    });
  }

  const uiMutations: [string, (u: SignatureUiState) => SignatureUiState][] = [
    ['expanded', (u) => ({ ...u, expanded: true })],
    ['showHidden', (u) => ({ ...u, showHidden: true })],
    ['viewMode', (u) => ({ ...u, viewMode: 'list' })],
    ['cost', (u) => ({ ...u, cost: 1.23 })],
  ];
  for (const [label, mut] of uiMutations) {
    it(`changes when ui ${label} changes`, () => {
      expect(projectSignature(baseInput, mut(baseUi))).not.toBe(projectSignature(baseInput, baseUi));
    });
  }

  // cost normalization: undefined (not yet scanned) and null (scanned, no cost) both
  // render as nothing, so they must not trigger a needless rebuild on first load.
  it('treats cost undefined and null as identical', () => {
    expect(projectSignature(baseInput, { ...baseUi, cost: undefined }))
      .toBe(projectSignature(baseInput, { ...baseUi, cost: null }));
  });
  it('changes when the live status changes (attention stripe must re-render)', () => {
    const base = projectSignature(baseInput, baseUi);
    expect(projectSignature(baseInput, { ...baseUi, live: 'attention' })).not.toBe(base);
  });
  it('distinguishes a real cost from no cost', () => {
    expect(projectSignature(baseInput, { ...baseUi, cost: 1.23 }))
      .not.toBe(projectSignature(baseInput, { ...baseUi, cost: null }));
  });
  it('distinguishes different cost values', () => {
    expect(projectSignature(baseInput, { ...baseUi, cost: 1.23 }))
      .not.toBe(projectSignature(baseInput, { ...baseUi, cost: 4.56 }));
  });
});

describe('diffCards', () => {
  it('reuses every card when nothing changed', () => {
    const prev = new Map([['a', 's1'], ['b', 's2']]);
    const r = diffCards(prev, [{ key: 'a', sig: 's1' }, { key: 'b', sig: 's2' }]);
    expect([...r.reuse].sort()).toEqual(['a', 'b']);
    expect(r.rebuild).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  it('rebuilds only the card whose signature changed', () => {
    const prev = new Map([['a', 's1'], ['b', 's2']]);
    const r = diffCards(prev, [{ key: 'a', sig: 's1' }, { key: 'b', sig: 's2-new' }]);
    expect([...r.reuse]).toEqual(['a']);
    expect(r.rebuild).toEqual(['b']);
    expect(r.remove).toEqual([]);
  });

  it('rebuilds a newly added card', () => {
    const prev = new Map([['a', 's1']]);
    const r = diffCards(prev, [{ key: 'a', sig: 's1' }, { key: 'c', sig: 's3' }]);
    expect([...r.reuse]).toEqual(['a']);
    expect(r.rebuild).toEqual(['c']);
    expect(r.remove).toEqual([]);
  });

  it('removes a card that is no longer desired', () => {
    const prev = new Map([['a', 's1'], ['b', 's2']]);
    const r = diffCards(prev, [{ key: 'a', sig: 's1' }]);
    expect([...r.reuse]).toEqual(['a']);
    expect(r.rebuild).toEqual([]);
    expect(r.remove).toEqual(['b']);
  });

  it('handles reuse, rebuild, and removal together in desired order', () => {
    const prev = new Map([['a', 's1'], ['b', 's2'], ['c', 's3']]);
    const r = diffCards(prev, [
      { key: 'a', sig: 's1' },      // reuse
      { key: 'b', sig: 's2-new' },  // rebuild (changed)
      { key: 'd', sig: 's4' },      // rebuild (new)
    ]);
    expect([...r.reuse]).toEqual(['a']);
    expect(r.rebuild).toEqual(['b', 'd']); // desired order preserved
    expect(r.remove).toEqual(['c']);       // gone from desired
  });
});

// Backs the deck toolbar pulse's click-to-filter (⚠/◉ segments): narrows a project list to
// those in a given live cockpit status. Pure so the composition with the deck's other filters
// (search / 방치만-neglected / show-hidden, all applied by the caller before this one) is
// testable without touching the DOM.
describe('filterByLive', () => {
  const items = [{ path: '/a' }, { path: '/b' }, { path: '/c' }];

  it('returns every item unchanged when no filter is active', () => {
    const act = new Map<string, 'attention' | 'working'>([['/a', 'attention'], ['/b', 'working']]);
    expect(filterByLive(items, act, '')).toEqual(items);
  });

  it('keeps only attention-status projects when filtering by attention', () => {
    const act = new Map<string, 'attention' | 'working'>([['/a', 'attention'], ['/b', 'working']]);
    expect(filterByLive(items, act, 'attention')).toEqual([items[0]]);
  });

  it('keeps only working-status projects when filtering by working', () => {
    const act = new Map<string, 'attention' | 'working'>([['/a', 'attention'], ['/b', 'working']]);
    expect(filterByLive(items, act, 'working')).toEqual([items[1]]);
  });

  it('excludes a project with no entry in the activity map for any active filter', () => {
    // '/c' has no live cockpit session at all -> absent from `act` -> never matches.
    const act = new Map<string, 'attention' | 'working'>([['/a', 'attention'], ['/b', 'working']]);
    expect(filterByLive(items, act, 'attention')).not.toContainEqual(items[2]);
    expect(filterByLive(items, act, 'working')).not.toContainEqual(items[2]);
  });

  it('returns an empty array when the filtered status has no matching projects', () => {
    const act = new Map<string, 'attention' | 'working'>([['/a', 'working']]);
    expect(filterByLive(items, act, 'attention')).toEqual([]);
  });
});
