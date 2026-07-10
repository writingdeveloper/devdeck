import { describe, it, expect } from 'vitest';
import { emptyTotals, addUsage, estimateCost, MODEL_PRICING, priceFor, SONNET5_ROLLOFF_MS, activeMsFromTimestamps, formatDuration, ACTIVE_GAP_CAP_MS } from './usage';

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
  it('prices Opus 4.8 at the current $5/$25 per Mtok (not the retired $15/$75)', () => {
    // Opus dropped to $5/$25 at 4.6; the old $15/$75 card 3x-inflated every Opus 4.8 cost estimate.
    expect(MODEL_PRICING['claude-opus-4-8']).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
  });
  it('has a price card for claude-fable-5 at $10/$50 per Mtok', () => {
    expect(MODEL_PRICING['claude-fable-5']).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 });
  });
  it('has a price card for claude-sonnet-5 at introductory $2/$10 per Mtok (through 2026-08-31)', () => {
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  });
});

describe('priceFor', () => {
  it('resolves an exact MODEL_PRICING key', () => {
    // sonnet-5 is date-aware; pin a pre-rollover date so this asserts key resolution, not the rollover.
    expect(priceFor('claude-sonnet-5', Date.UTC(2026, 0, 1))).toEqual(MODEL_PRICING['claude-sonnet-5']);
    expect(priceFor('claude-fable-5')).toEqual(MODEL_PRICING['claude-fable-5']);
  });
  it('strips a trailing -YYYYMMDD date suffix and retries', () => {
    // claude-haiku-4-5-20251001 has no exact key, but claude-haiku-4-5 does.
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(MODEL_PRICING['claude-haiku-4-5']);
  });
  it('maps bare family aliases to the newest card for that family', () => {
    expect(priceFor('opus')).toEqual(MODEL_PRICING['claude-opus-4-8']);
    expect(priceFor('sonnet', Date.UTC(2026, 0, 1))).toEqual(MODEL_PRICING['claude-sonnet-5']); // pre-rollover
    expect(priceFor('haiku')).toEqual(MODEL_PRICING['claude-haiku-4-5']);
    expect(priceFor('fable')).toEqual(MODEL_PRICING['claude-fable-5']);
  });
  it('returns undefined for non-Claude ids and empty string', () => {
    expect(priceFor('ltx-2.3-22b-distilled')).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
  });
  it('returns undefined for an unrecognized dated id whose stripped base has no card', () => {
    expect(priceFor('mystery-model-20260101')).toBeUndefined();
  });
});

describe('Sonnet-5 introductory-price rollover', () => {
  const INTRO = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
  const STANDARD = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  it('uses the introductory rate just before the 2026-09-01 rollover', () => {
    expect(priceFor('claude-sonnet-5', SONNET5_ROLLOFF_MS - 1)).toEqual(INTRO);
  });
  it('auto-switches to the standard Sonnet-tier rate at/after the rollover — no manual edit', () => {
    expect(priceFor('claude-sonnet-5', SONNET5_ROLLOFF_MS)).toEqual(STANDARD);
    expect(priceFor('claude-sonnet-5', SONNET5_ROLLOFF_MS + 86_400_000)).toEqual(STANDARD);
  });
  it('applies the rollover through the bare "sonnet" alias and a dated id too', () => {
    expect(priceFor('sonnet', SONNET5_ROLLOFF_MS)).toEqual(STANDARD);
    expect(priceFor('claude-sonnet-5-20260901', SONNET5_ROLLOFF_MS)).toEqual(STANDARD);
  });
  it('leaves other families unaffected by the date', () => {
    expect(priceFor('claude-haiku-4-5', SONNET5_ROLLOFF_MS)).toEqual(MODEL_PRICING['claude-haiku-4-5']);
    expect(priceFor('claude-opus-4-8', SONNET5_ROLLOFF_MS)).toEqual(MODEL_PRICING['claude-opus-4-8']);
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
