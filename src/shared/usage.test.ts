import { describe, it, expect } from 'vitest';
import { emptyTotals, addUsage, estimateCost, MODEL_PRICING, activeMsFromTimestamps, formatDuration, ACTIVE_GAP_CAP_MS } from './usage';

describe('addUsage', () => {
  it('accumulates the four token categories', () => {
    let t = emptyTotals();
    t = addUsage(t, { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 });
    t = addUsage(t, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(t).toEqual({ input: 11, output: 22, cacheWrite: 5, cacheRead: 100 });
  });
  it('treats missing fields as zero', () => {
    expect(addUsage(emptyTotals(), { output_tokens: 7 })).toEqual({ input: 0, output: 7, cacheWrite: 0, cacheRead: 0 });
  });
});

describe('estimateCost', () => {
  it('computes cost per million tokens using the model price card', () => {
    const price = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
    const totals = { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 };
    expect(estimateCost(totals, price)).toBeCloseTo(15 + 75 + 18.75 + 1.5, 5);
  });
  it('returns null for an unknown model (no price card)', () => {
    expect(estimateCost({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, undefined)).toBeNull();
  });
  it('has a price card for the current Opus model id', () => {
    expect(MODEL_PRICING['claude-opus-4-8']).toBeDefined();
  });
});

describe('activeMsFromTimestamps', () => {
  const T = (min: number) => Date.UTC(2026, 5, 1, 10, 0, 0) + min * 60_000;

  it('sums consecutive gaps within the idle cap', () => {
    // gaps: 2m, 3m — both <= 5m → 5m total
    expect(activeMsFromTimestamps([T(0), T(2), T(5)])).toBe(5 * 60_000);
  });

  it('excludes gaps larger than the idle cap (overnight / away)', () => {
    // 2m active, then a 600m idle gap (skipped), then 1m active → 3m total
    expect(activeMsFromTimestamps([T(0), T(2), T(602), T(603)])).toBe(3 * 60_000);
  });

  it('drops a gap exactly over the cap but keeps one exactly at the cap', () => {
    const capMin = ACTIVE_GAP_CAP_MS / 60_000;
    expect(activeMsFromTimestamps([T(0), T(capMin)])).toBe(ACTIVE_GAP_CAP_MS);
    expect(activeMsFromTimestamps([T(0), T(capMin + 1)])).toBe(0);
  });

  it('sorts unordered input and returns 0 for <2 stamps', () => {
    expect(activeMsFromTimestamps([T(2), T(0), T(5)])).toBe(5 * 60_000);
    expect(activeMsFromTimestamps([T(0)])).toBe(0);
    expect(activeMsFromTimestamps([])).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration((14 * 60 + 9) * 60_000)).toBe('14h 9m');
  });
  it('drops the hours part below one hour', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m');
  });
  it('floors to whole minutes and clamps negatives to 0m', () => {
    expect(formatDuration(59_000)).toBe('0m');
    expect(formatDuration(-1000)).toBe('0m');
  });
});
