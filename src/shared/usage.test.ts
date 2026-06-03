import { describe, it, expect } from 'vitest';
import { emptyTotals, addUsage, estimateCost, MODEL_PRICING } from './usage';

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
