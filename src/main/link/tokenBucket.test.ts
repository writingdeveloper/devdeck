import { describe, it, expect } from 'vitest';
import { makeTokenBucket } from './tokenBucket';

describe('token bucket', () => {
  it('serves a burst up to capacity and then refuses', () => {
    let t = 0;
    const bucket = makeTokenBucket({ capacity: 3, refillPerMs: 0, now: () => t });
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true]);
    expect(bucket.take()).toBe(false);
  });

  it('refills with time, never above capacity', () => {
    let t = 0;
    const bucket = makeTokenBucket({ capacity: 2, refillPerMs: 1 / 1000, now: () => t }); // one per second
    bucket.take(); bucket.take();
    expect(bucket.take()).toBe(false);
    t = 1_000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    t = 100_000;
    expect(bucket.available).toBe(2);
  });
});
