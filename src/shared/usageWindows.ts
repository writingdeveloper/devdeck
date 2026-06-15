// src/shared/usageWindows.ts
export type Severity = 'ok' | 'warn' | 'crit';

export interface UsageWindows {
  planName: string | null;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourResetAt: number | null; // epoch ms
  sevenDayResetAt: number | null;
}

export type UsageResult =
  | { enabled: false }
  | { enabled: true; data: UsageWindows }
  | { enabled: true; error: 'no-credentials' | 'expired' | 'offline' | 'rate-limited' | 'not-applicable' };

export function severity(pct: number): Severity {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

export function clampPct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(100, v)));
}

/** Format the time until a reset. `t` is the i18n lookup; templates use `Xh`/`Ym` placeholders. */
export function formatReset(resetAtMs: number, nowMs: number, t: (k: string) => string): string {
  const ms = resetAtMs - nowMs;
  if (ms < 60_000) return t('usage.reset_soon');
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return t('usage.reset_h').replace('X', String(h)).replace('Y', String(m));
  return t('usage.reset_m').replace('Y', String(m));
}

function parseResetAt(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Parse the raw `/api/oauth/usage` body into utilization + reset epoch ms. planName is set by the caller. */
export function parseUsageResponse(body: unknown): Omit<UsageWindows, 'planName'> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  return {
    fiveHour: clampPct(b.five_hour?.utilization),
    sevenDay: clampPct(b.seven_day?.utilization),
    fiveHourResetAt: parseResetAt(b.five_hour?.resets_at),
    sevenDayResetAt: parseResetAt(b.seven_day?.resets_at),
  };
}
