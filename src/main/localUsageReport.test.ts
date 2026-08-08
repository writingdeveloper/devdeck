import { describe, expect, it } from 'vitest';
import { emptyProviderUsage, type ProviderUsageSlice } from '../shared/localUsage';
import { combineLocalUsageScans } from './localUsageReport';

function priced(providerId: 'claude' | 'codex', cost: number): ProviderUsageSlice {
  return { ...emptyProviderUsage(providerId), globalCost: cost, global: { input: cost * 10, output: 0, cacheWrite: 0, cacheRead: 0 } };
}

describe('combineLocalUsageScans', () => {
  it('combines successful Claude and Codex scans', async () => {
    const report = await combineLocalUsageScans(Promise.resolve(priced('claude', 3)), Promise.resolve(priced('codex', 2)));
    expect(report.globalCost).toBe(5);
    expect(report.byProvider.map((provider) => provider.providerId)).toEqual(['claude', 'codex']);
  });

  it('keeps Claude data and marks Codex unavailable when only Codex fails', async () => {
    const report = await combineLocalUsageScans(Promise.resolve(priced('claude', 3)), Promise.reject(new Error('codex unavailable')));
    expect(report.globalCost).toBe(3);
    expect(report.byProvider.find((provider) => provider.providerId === 'codex')?.state).toBe('error');
  });

  it('keeps Codex data and marks Claude unavailable when only Claude fails', async () => {
    const report = await combineLocalUsageScans(Promise.reject(new Error('claude unavailable')), Promise.resolve(priced('codex', 2)));
    expect(report.globalCost).toBe(2);
    expect(report.byProvider.find((provider) => provider.providerId === 'claude')?.state).toBe('error');
  });
});
