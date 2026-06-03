import type { StaleInfo, StaleThresholds } from './types';

export const DEFAULT_THRESHOLDS: StaleThresholds = { freshDays: 1, warnDays: 3, neglectedDays: 7 };

const DAY = 86_400_000;

export function classifyStaleness(activityMs: number | null, nowMs: number, t: StaleThresholds): StaleInfo {
  if (activityMs == null) return { level: 'neglected', ageDays: null };
  const raw = (nowMs - activityMs) / DAY;
  const ageDays = Math.floor(raw);
  if (raw < t.freshDays) return { level: 'fresh', ageDays };
  if (raw < t.warnDays) return { level: 'neutral', ageDays };
  if (raw < t.neglectedDays) return { level: 'warn', ageDays };
  return { level: 'neglected', ageDays };
}
