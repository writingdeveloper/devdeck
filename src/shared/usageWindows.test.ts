// src/shared/usageWindows.test.ts
import { describe, it, expect } from 'vitest';
import { severity, clampPct, formatReset, parseUsageResponse, usageErrorKey } from './usageWindows';

describe('severity', () => {
  it('ok < 70, warn 70..89, crit >= 90', () => {
    expect(severity(0)).toBe('ok');
    expect(severity(69)).toBe('ok');
    expect(severity(70)).toBe('warn');
    expect(severity(89)).toBe('warn');
    expect(severity(90)).toBe('crit');
    expect(severity(100)).toBe('crit');
  });
});

describe('clampPct', () => {
  it('rounds and clamps 0..100, null on non-finite', () => {
    expect(clampPct(18.4)).toBe(18);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(Number.NaN)).toBeNull();
    expect(clampPct(Infinity)).toBeNull();
    expect(clampPct(undefined)).toBeNull();
  });
});

describe('formatReset', () => {
  const t = (k: string) => ({ 'usage.reset_soon': '곧', 'usage.reset_d': 'Xd Yh 후', 'usage.reset_h': 'Xh Ym 후', 'usage.reset_m': 'Ym 후' }[k] ?? k);
  it('days + hours (weekly window)', () => {
    expect(formatReset(1000 + (3 * 1440 + 4 * 60) * 60000, 1000, t)).toBe('3d 4h 후');
  });
  it('hours + minutes', () => {
    expect(formatReset(1000 + (4 * 60 + 12) * 60000, 1000, t)).toBe('4h 12m 후');
  });
  it('minutes only', () => {
    expect(formatReset(1000 + 12 * 60000, 1000, t)).toBe('12m 후');
  });
  it('past or <1m => soon', () => {
    expect(formatReset(1000, 1000, t)).toBe('곧');
    expect(formatReset(500, 1000, t)).toBe('곧');
  });
});

describe('usageErrorKey', () => {
  it('hides (null) when not logged in or not applicable — no nagging', () => {
    expect(usageErrorKey('no-credentials')).toBeNull();
    expect(usageErrorKey('not-applicable')).toBeNull();
  });
  it('maps each transient failure to a specific, actionable message key', () => {
    expect(usageErrorKey('expired')).toBe('usage.bar_expired');
    expect(usageErrorKey('rate-limited')).toBe('usage.bar_ratelimited');
    expect(usageErrorKey('offline')).toBe('usage.bar_unavailable');
  });
});

describe('parseUsageResponse', () => {
  it('extracts utilization + resets_at', () => {
    const body = {
      five_hour: { utilization: 18.6, resets_at: '2026-06-15T14:32:00Z' },
      seven_day: { utilization: 31, resets_at: '2026-06-20T00:00:00Z' },
    };
    const r = parseUsageResponse(body)!;
    expect(r.fiveHour).toBe(19);
    expect(r.sevenDay).toBe(31);
    expect(r.fiveHourResetAt).toBe(Date.parse('2026-06-15T14:32:00Z'));
    expect(r.sevenDayResetAt).toBe(Date.parse('2026-06-20T00:00:00Z'));
  });
  it('tolerates missing fields', () => {
    const r = parseUsageResponse({})!;
    expect(r.fiveHour).toBeNull();
    expect(r.sevenDay).toBeNull();
    expect(r.fiveHourResetAt).toBeNull();
  });
  it('null on non-object', () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse('x')).toBeNull();
  });
});
