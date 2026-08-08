import { describe, expect, it } from 'vitest';
import {
  combineProviderUsage, emptyProviderUsage, selectProviderUsage,
  type ProviderUsageSlice,
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
