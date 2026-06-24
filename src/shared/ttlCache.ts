/**
 * Tiny single-entry TTL cache. `now` is injected (not read from Date) so the logic is pure and
 * unit-testable. Used to share ONE folder scan between projects:list and usage:report on the same
 * deck reload — previously each handler ran scanFolders independently, doubling the disk walk + git
 * probes. Caching the Promise (not the resolved value) means two near-simultaneous callers await the
 * same in-flight scan. Single entry is enough: the key is the folder set, which is identical for both.
 */
export function makeTtlCache<T>(ttlMs: number) {
  let entry: { key: string; ts: number; value: T } | null = null;
  return {
    get(key: string, now: number): T | undefined {
      return entry && entry.key === key && now - entry.ts < ttlMs ? entry.value : undefined;
    },
    set(key: string, now: number, value: T): void {
      entry = { key, ts: now, value };
    },
  };
}
