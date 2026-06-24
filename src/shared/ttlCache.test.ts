import { describe, it, expect } from 'vitest';
import { makeTtlCache } from './ttlCache';

describe('makeTtlCache', () => {
  it('returns the cached value for the same key within the TTL', () => {
    const c = makeTtlCache<number>(1000);
    c.set('k', 0, 42);
    expect(c.get('k', 500)).toBe(42); // 500ms < 1000ms TTL → hit
  });
  it('misses once the TTL has elapsed (boundary is exclusive)', () => {
    const c = makeTtlCache<number>(1000);
    c.set('k', 0, 42);
    expect(c.get('k', 1000)).toBeUndefined(); // exactly at TTL = expired
    expect(c.get('k', 1500)).toBeUndefined();
  });
  it('keeps only one entry: a new key evicts the previous one', () => {
    const c = makeTtlCache<number>(1000);
    c.set('a', 0, 1);
    c.set('b', 0, 2);
    expect(c.get('a', 100)).toBeUndefined(); // 'b' replaced 'a'
    expect(c.get('b', 100)).toBe(2);
  });
  it('caches a Promise so two callers share one in-flight computation', async () => {
    const c = makeTtlCache<Promise<number>>(1000);
    let runs = 0;
    const compute = () => { runs++; return Promise.resolve(7); };
    const a = c.get('k', 0) ?? (() => { const p = compute(); c.set('k', 0, p); return p; })();
    const b = c.get('k', 1) ?? (() => { const p = compute(); c.set('k', 1, p); return p; })();
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(runs).toBe(1); // second caller reused the cached promise — no second compute
  });
});
