import type { StaleInfo, StaleThresholds } from './types';

export const DEFAULT_THRESHOLDS: StaleThresholds = {
  freshDays: 1,
  warnDays: 3,
  neglectedDays: 7,
};

const DAY = 86_400_000;

function dayLabel(ageDays: number): string {
  if (ageDays < 1) return '오늘';
  return `${Math.floor(ageDays)}일`;
}

export function classifyStaleness(
  activityMs: number | null,
  nowMs: number,
  t: StaleThresholds,
): StaleInfo {
  if (activityMs == null) return { level: 'neglected', badge: '⚪ 기록 없음' };
  const ageDays = (nowMs - activityMs) / DAY;
  const label = dayLabel(ageDays);
  if (ageDays < t.freshDays) return { level: 'fresh', badge: `🟢 ${label}` };
  if (ageDays < t.warnDays) return { level: 'neutral', badge: `⚪ ${label}` };
  if (ageDays < t.neglectedDays) return { level: 'warn', badge: `🟡 ${label}` };
  return { level: 'neglected', badge: `🔴 ${label}` };
}
