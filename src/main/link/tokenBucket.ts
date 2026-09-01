/**
 * A token bucket: `capacity` calls at once, refilling at `refillPerMs`.
 *
 * Used per link connection to bound how many requests a paired machine can make of this one. A
 * paired device is trusted to drive sessions, not to schedule a thousand usage scans a second — and
 * one that has gone wrong (a viewer stuck in a retry loop) should be slowed, not served.
 */
export interface TokenBucket {
  /** Spend one token. False when the bucket is empty — the caller refuses the work. */
  take(): boolean;
  /** Tokens available right now, after refilling. */
  readonly available: number;
}

export function makeTokenBucket(options: { capacity: number; refillPerMs: number; now?: () => number }): TokenBucket {
  const now = options.now ?? Date.now;
  const capacity = Math.max(1, options.capacity);
  let tokens = capacity;
  let last = now();
  const refill = (): void => {
    const t = now();
    if (t > last) {
      tokens = Math.min(capacity, tokens + (t - last) * options.refillPerMs);
      last = t;
    }
  };
  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get available() { refill(); return Math.floor(tokens); },
  };
}
