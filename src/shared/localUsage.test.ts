import { describe, expect, it } from 'vitest';
import {
  combineProviderUsage, emptyProviderUsage, selectProviderUsage, todayCost, usageDayKey,
  type LocalDailyUsage, type ProviderUsageSlice,
} from './localUsage';

const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function slice(providerId: 'claude' | 'codex', cost: number, path: string): ProviderUsageSlice {
  const totals = providerId === 'claude'
    ? { ...zero, input: 10, output: 2 }
    : { ...zero, input: 20, output: 3, cacheRead: 5 };
  return {
    providerId, state: 'ready', global: totals, globalCost: cost, hasUnknownModel: false,
    webSearch: providerId === 'claude' ? 2 : 0, webFetch: 0, sessions: 1, activeMs: 60_000,
    byModel: [{ providerId, model: providerId === 'claude' ? 'claude-opus-4-8' : 'gpt-5.6-sol', totals, costEstimate: cost, hasUnknownPrice: false }],
    byProject: [{
      path, name: 'devdeck', sessions: 1, totals, costEstimate: cost, hasUnknownModel: false,
      activeMs: 60_000, status: 'active', providerCosts: { [providerId]: cost },
    }],
    daily: [{ day: '2026-08-08', tokens: totals.input + totals.output, cost, providerTokens: { [providerId]: totals.input + totals.output }, providerCosts: { [providerId]: cost } }],
  };
}

describe('combineProviderUsage', () => {
  it('shows combined and provider costs while merging the same canonical project', () => {
    const report = combineProviderUsage([
      slice('claude', 7.5, 'C:\\Work\\DevDeck'),
      slice('codex', 5, 'c:/work/devdeck/'),
    ]);

    expect(report.globalCost).toBeCloseTo(12.5);
    expect(report.byProvider.map((p) => [p.providerId, p.globalCost])).toEqual([
      ['claude', 7.5],
      ['codex', 5],
    ]);
    expect(report.byProject).toHaveLength(1);
    expect(report.byProject[0].providerCosts).toEqual({ claude: 7.5, codex: 5 });
    expect(report.byProject[0].sessions).toBe(2);
    expect(report.daily[0].providerCosts).toEqual({ claude: 7.5, codex: 5 });
  });

  it('keeps a known subtotal while marking a combined estimate partial', () => {
    const claude = slice('claude', 3, 'C:\\p');
    const codex = slice('codex', 2, 'C:\\q');
    codex.hasUnknownModel = true;
    codex.byModel[0].hasUnknownPrice = true;

    const report = combineProviderUsage([claude, codex]);
    expect(report.globalCost).toBe(5);
    expect(report.hasUnknownModel).toBe(true);
  });

  it('returns the combined or provider detail without mutating the report', () => {
    const report = combineProviderUsage([slice('claude', 7.5, 'C:\\p'), slice('codex', 5, 'C:\\q')]);
    expect(selectProviderUsage(report, 'all').globalCost).toBe(12.5);
    expect(selectProviderUsage(report, 'codex').globalCost).toBe(5);
    expect(selectProviderUsage(report, 'codex').byModel.every((m) => m.providerId === 'codex')).toBe(true);
    expect(report.byProject).toHaveLength(2);
  });

  it('keeps an unavailable provider visible without blanking valid data', () => {
    const report = combineProviderUsage([slice('claude', 7.5, 'C:\\p'), emptyProviderUsage('codex', 'error')]);
    expect(report.globalCost).toBe(7.5);
    expect(report.byProvider.find((p) => p.providerId === 'codex')?.state).toBe('error');
  });
});

describe('todayCost', () => {
  const row = (day: string, cost: number | null): LocalDailyUsage =>
    ({ day, tokens: 1, cost, providerTokens: {}, providerCosts: {} });
  const noon = Date.parse('2026-08-26T12:00:00.000Z');

  it("reads today's cost out of a report that already covers today", () => {
    // The deck ran a SECOND full scan bounded to midnight to get this number, every 45 seconds and
    // again on every window focus, over a session store that reached 4.35 GB. The first scan had it.
    expect(todayCost([row('2026-08-25', 3), row('2026-08-26', 7.5)], noon)).toBe(7.5);
  });

  it('answers null when today has no priced usage, and when today has no row at all', () => {
    // Both mean the same thing to the caller — "no figure to show" — and both used to come back as
    // the since-midnight scan's null globalCost.
    expect(todayCost([row('2026-08-26', null)], noon)).toBeNull();
    expect(todayCost([row('2026-08-25', 3)], noon)).toBeNull();
    expect(todayCost([], noon)).toBeNull();
  });

  it('buckets by UTC, the calendar the rows were built in', () => {
    // dayKey() in the scanner is toISOString().slice(0,10). Asking in local time would miss the row
    // by a day for anyone far enough from UTC — which is everyone this app is used by.
    expect(usageDayKey(Date.parse('2026-08-26T23:59:59.999Z'))).toBe('2026-08-26');
    expect(usageDayKey(Date.parse('2026-08-27T00:00:00.000Z'))).toBe('2026-08-27');
    expect(todayCost([row('2026-08-27', 2)], Date.parse('2026-08-27T00:00:00.000Z'))).toBe(2);
  });
});
