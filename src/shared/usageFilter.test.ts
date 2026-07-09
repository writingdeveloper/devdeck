import { describe, it, expect } from 'vitest';
import { filterProjectRows } from './usageFilter';
import type { ProjectUsage } from './types';

const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function row(name: string): ProjectUsage {
  return { path: `/p/${name}`, name, sessions: 1, totals, costEstimate: null, hasUnknownModel: false, activeMs: 0, status: 'active' };
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
