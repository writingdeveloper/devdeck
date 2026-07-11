import { describe, it, expect } from 'vitest';
import { filterProjectRows, aggregateDeleted } from './usageFilter';
import type { ProjectUsage } from './types';

const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function row(name: string): ProjectUsage {
  return { path: `/p/${name}`, name, sessions: 1, totals, costEstimate: null, hasUnknownModel: false, activeMs: 0, status: 'active' };
}

function mkRow(over: Partial<ProjectUsage>): ProjectUsage {
  return { path: 'p', name: 'n', sessions: 0, totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, costEstimate: null, hasUnknownModel: false, activeMs: 0, status: 'active', ...over };
}

describe('filterProjectRows', () => {
  const rows = [row('devdeck'), row('marketdeck'), row('Fable')];

  it('returns all rows when the query is empty', () => {
    expect(filterProjectRows(rows, '')).toEqual(rows);
  });

  it('returns all rows when the query is whitespace-only', () => {
    expect(filterProjectRows(rows, '   ')).toEqual(rows);
  });

  it('filters by case-insensitive substring match on name', () => {
    expect(filterProjectRows(rows, 'deck')).toEqual([row('devdeck'), row('marketdeck')]);
  });

  it('matches regardless of query case', () => {
    expect(filterProjectRows(rows, 'FABLE')).toEqual([row('Fable')]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterProjectRows(rows, 'nope')).toEqual([]);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(filterProjectRows(rows, '  fable  ')).toEqual([row('Fable')]);
  });
});

describe('aggregateDeleted', () => {
  it('returns null when there are no deleted rows', () => {
    expect(aggregateDeleted([mkRow({ status: 'active' }), mkRow({ status: 'active' })])).toBeNull();
  });

  it('folds deleted rows into one group (count, sessions, tokens, cost, active time); ignores active rows', () => {
    const g = aggregateDeleted([
      mkRow({ status: 'active', costEstimate: 100, sessions: 9, activeMs: 9999 }), // must be excluded
      mkRow({ status: 'deleted', sessions: 2, activeMs: 1000, costEstimate: 1.5, totals: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } }),
      mkRow({ status: 'deleted', sessions: 3, activeMs: 2000, costEstimate: 0.5, totals: { input: 20, output: 7, cacheWrite: 1, cacheRead: 2 } }),
    ])!;
    expect(g.count).toBe(2);
    expect(g.sessions).toBe(5);
    expect(g.activeMs).toBe(3000);
    expect(g.costEstimate).toBeCloseTo(2.0, 6);
    expect(g.totals).toEqual({ input: 30, output: 12, cacheWrite: 1, cacheRead: 2 });
  });

  it('sums only priced deleted rows (null cost only when none are priced) and flags unknown models', () => {
    const partial = aggregateDeleted([
      mkRow({ status: 'deleted', costEstimate: null, hasUnknownModel: true }),
      mkRow({ status: 'deleted', costEstimate: 2 }),
    ])!;
    expect(partial.costEstimate).toBeCloseTo(2, 6); // the one priced row, not null
    expect(partial.hasUnknownModel).toBe(true);

    const none = aggregateDeleted([mkRow({ status: 'deleted', costEstimate: null })])!;
    expect(none.costEstimate).toBeNull();
    expect(none.hasUnknownModel).toBe(false);
  });
});
