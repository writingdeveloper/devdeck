/**
 * The key two callers of `usage:report` share a scan under.
 *
 * A scan walks every session store on the machine, so concurrent asks must share one — but they ask
 * with different numbers: the deck sends 0 (everything), the usage view sends `now - N days`, a value
 * that changes every millisecond. Keyed on the exact number, nothing was ever shared. Keyed on the
 * DAY the range starts, two asks for the same range on the same day are the same question, and
 * `Infinity`/`0` keep their own buckets so "everything" is never answered with "the last week".
 */
export function usageInFlightKey(sinceMs: number): string {
  if (sinceMs === Infinity) return 'all';
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return '0';
  return String(Math.floor(sinceMs / 86_400_000));
}
