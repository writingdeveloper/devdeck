// src/shared/usageWindows.test.ts
import { describe, it, expect } from 'vitest';
import {
  usageSeverity, clampPercent, parseResetTime, safeUsageLabel, formatReset,
  parseClaudeUsageResponse, usageStateKey,
} from './usageWindows';

describe('usageSeverity', () => {
  it('ok < 70, warn 70..89, crit >= 90', () => {
    expect(usageSeverity(0)).toBe('ok');
    expect(usageSeverity(69)).toBe('ok');
    expect(usageSeverity(70)).toBe('warn');
    expect(usageSeverity(89)).toBe('warn');
    expect(usageSeverity(90)).toBe('crit');
    expect(usageSeverity(100)).toBe('crit');
  });
});

describe('clampPercent', () => {
  it('rounds and clamps 0..100, null on non-finite', () => {
    expect(clampPercent(18.4)).toBe(18);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(130)).toBe(100);
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(undefined)).toBeNull();
    expect(clampPercent('40')).toBeNull(); // a string percentage is untrusted junk, not 40
  });
});

describe('parseResetTime', () => {
  it('accepts an ISO timestamp, rejects junk and overlong input', () => {
    expect(parseResetTime('2026-06-15T14:32:00Z')).toBe(Date.parse('2026-06-15T14:32:00Z'));
    expect(parseResetTime('not a date')).toBeNull();
    expect(parseResetTime(12345)).toBeNull();
    expect(parseResetTime('2026-06-15T14:32:00Z'.padEnd(200, ' '))).toBeNull();
  });
});

describe('safeUsageLabel', () => {
  it('trims, caps at 80 chars, and falls back on empty input', () => {
    expect(safeUsageLabel('  Fable 5  ', 'x')).toBe('Fable 5');
    expect(safeUsageLabel('', 'fallback')).toBe('fallback');
    expect(safeUsageLabel(null, 'fallback')).toBe('fallback');
    expect(safeUsageLabel('a'.repeat(200), 'x')).toHaveLength(80);
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

describe('usageStateKey', () => {
  it('maps every normalized state to an i18n key', () => {
    for (const s of ['ready', 'stale', 'login-required', 'expired', 'not-applicable', 'cli-missing', 'offline', 'rate-limited', 'unsupported'] as const) {
      expect(usageStateKey(s)).toMatch(/^usage\.state_/);
    }
  });
});

describe('parseClaudeUsageResponse', () => {
  const ISO_5H = '2026-06-15T14:32:00Z';
  const ISO_WEEK = '2026-06-20T00:00:00Z';

  it('parses the legacy fixed five_hour / seven_day windows', () => {
    const r = parseClaudeUsageResponse({
      five_hour: { utilization: 18.6, resets_at: ISO_5H },
      seven_day: { utilization: 31, resets_at: ISO_WEEK },
    })!;
    expect(r.limits).toEqual([
      { id: 'claude:session', kind: 'session', label: 'usage.limit_session', percent: 19, resetAt: Date.parse(ISO_5H), modelLabel: null },
      { id: 'claude:weekly', kind: 'weekly', label: 'usage.limit_weekly', percent: 31, resetAt: Date.parse(ISO_WEEK), modelLabel: null },
    ]);
    expect(r.credits).toBeNull();
  });

  it('parses the dynamic limits array, including a model-scoped entry', () => {
    const r = parseClaudeUsageResponse({
      limits: [
        { type: 'five_hour', utilization: 12, resets_at: ISO_5H },
        { type: 'seven_day', utilization: 44, resets_at: ISO_WEEK },
        { type: 'seven_day', utilization: 61, resets_at: ISO_WEEK, model: 'fable-5', model_display_name: 'Fable 5' },
      ],
    })!;
    expect(r.limits).toHaveLength(3);
    const scoped = r.limits.filter((l) => l.kind === 'model-weekly');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].modelLabel).toBe('Fable 5');
    expect(scoped[0].percent).toBe(61);
    expect(scoped[0].id).toBe('claude:seven_day:fable-5');
  });

  // Fable's included allowance ended 2026-07-07; accounts without that entry must not show an empty row.
  it('is data-driven: no model row when the response omits one', () => {
    const r = parseClaudeUsageResponse({ limits: [{ type: 'five_hour', utilization: 5, resets_at: ISO_5H }] })!;
    expect(r.limits.every((l) => l.kind !== 'model-weekly')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Fable');
  });

  it('keeps two different model-scoped limits apart', () => {
    const r = parseClaudeUsageResponse({
      limits: [
        { type: 'seven_day', utilization: 10, resets_at: ISO_WEEK, model: 'fable-5', model_display_name: 'Fable 5' },
        { type: 'seven_day', utilization: 20, resets_at: ISO_WEEK, model: 'opus-5', model_display_name: 'Opus 5' },
      ],
    })!;
    expect(r.limits.map((l) => l.id)).toEqual(['claude:seven_day:fable-5', 'claude:seven_day:opus-5']);
    expect(r.limits.map((l) => l.percent)).toEqual([10, 20]);
  });

  it('deduplicates repeated ids, last write wins', () => {
    const r = parseClaudeUsageResponse({
      limits: [
        { type: 'five_hour', utilization: 10, resets_at: ISO_5H },
        { type: 'five_hour', utilization: 80, resets_at: ISO_5H },
      ],
    })!;
    expect(r.limits).toHaveLength(1);
    expect(r.limits[0].percent).toBe(80);
  });

  it('reads Usage Credits when present', () => {
    const r = parseClaudeUsageResponse({
      five_hour: { utilization: 1, resets_at: ISO_5H },
      extra_usage: { has_credits: true, balance: 12.5, spent: 3.25, currency: 'USD' },
    })!;
    expect(r.credits).toEqual({ hasCredits: true, balance: 12.5, spent: 3.25, currency: 'USD' });
  });

  it('normalizes junk: bad percentages, invalid resets, overlong labels', () => {
    const r = parseClaudeUsageResponse({
      limits: [
        { type: 'five_hour', utilization: Number.NaN, resets_at: 'nope' },
        { type: 'seven_day', utilization: 130, resets_at: ISO_WEEK, model: 'm', model_display_name: 'M'.repeat(200) },
        { type: 'seven_day', utilization: -5, resets_at: ISO_WEEK, model: 'n', model_display_name: 'N' },
      ],
    })!;
    expect(r.limits[0].percent).toBeNull();
    expect(r.limits[0].resetAt).toBeNull();
    expect(r.limits[1].percent).toBe(100);
    expect(r.limits[1].modelLabel).toHaveLength(80);
    expect(r.limits[2].percent).toBe(0);
  });

  it('ignores unusable entries and non-object responses', () => {
    expect(parseClaudeUsageResponse(null)).toBeNull();
    expect(parseClaudeUsageResponse('x')).toBeNull();
    const r = parseClaudeUsageResponse({ limits: [null, 7, { utilization: 5 }] })!;
    expect(r.limits).toEqual([]); // an entry with no recognizable window type is dropped
  });
});
