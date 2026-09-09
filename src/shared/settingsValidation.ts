import type { StaleThresholds } from './types';

/** Finite positive whole days in order, enforced on both sides of IPC. */
export function validThresholds(value: unknown): value is StaleThresholds {
  if (!value || typeof value !== 'object') return false;
  const { freshDays: f, warnDays: w, neglectedDays: n } = value as StaleThresholds;
  return [f, w, n].every(v => Number.isSafeInteger(v) && v > 0) && f <= w && w <= n;
}
