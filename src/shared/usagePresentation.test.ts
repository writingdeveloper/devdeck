// src/shared/usagePresentation.test.ts
import { describe, it, expect } from 'vitest';
import { criticalUsageLimit, summarizeProviderUsage, staleAgeMinutes } from './usagePresentation';
import type { ProviderUsage, UsageLimit } from './usageWindows';
import type { AgentId } from './types';

const NOW = 1_700_000_000_000;

const limit = (id: string, percent: number | null): UsageLimit =>
  ({ id, kind: 'session', label: 'usage.limit_session', percent, resetAt: NOW + 60_000, modelLabel: null });

const provider = (providerId: AgentId, over: Partial<ProviderUsage> = {}): ProviderUsage =>
  ({ providerId, state: 'ready', planLabel: null, limits: [], credits: null, guidance: null, fetchedAt: NOW, ...over });

describe('criticalUsageLimit', () => {
  it('picks the highest percentage across providers', () => {
    const best = criticalUsageLimit([
      provider('claude', { limits: [limit('a', 30), limit('b', 82)] }),
      provider('codex', { limits: [limit('c', 55)] }),
    ])!;
    expect(best.provider.providerId).toBe('claude');
    expect(best.limit.id).toBe('b');
  });

  it('a null percentage never wins', () => {
    const best = criticalUsageLimit([provider('claude', { limits: [limit('a', null)] }), provider('codex', { limits: [limit('c', 3)] })])!;
    expect(best.limit.id).toBe('c');
    expect(criticalUsageLimit([provider('claude', { limits: [limit('a', null)] })])).toBeNull();
  });

  it('ignores providers with no usable numbers', () => {
    expect(criticalUsageLimit([
      provider('claude', { state: 'login-required', limits: [limit('a', 99)] }),
      provider('antigravity', { state: 'unsupported' }),
    ])).toBeNull();
  });

  it('stale data still counts (it is the best we have)', () => {
    const best = criticalUsageLimit([provider('claude', { state: 'stale', staleSince: NOW - 60_000, limits: [limit('a', 12)] })])!;
    expect(best.limit.percent).toBe(12);
  });
});

describe('summarizeProviderUsage', () => {
  it('reports the winning limit with its severity', () => {
    const s = summarizeProviderUsage({ providers: [provider('claude', { limits: [limit('a', 91)] })], fetchedAt: NOW });
    expect(s).toMatchObject({ kind: 'limit', providerId: 'claude', severity: 'crit', stale: false });
    expect(s.limit!.percent).toBe(91);
  });

  it('marks a stale winner as stale while keeping its signal', () => {
    const s = summarizeProviderUsage({ providers: [provider('codex', { state: 'stale', staleSince: NOW - 120_000, limits: [limit('a', 75)] })], fetchedAt: NOW });
    expect(s).toMatchObject({ kind: 'limit', providerId: 'codex', severity: 'warn', stale: true });
  });

  it('unsupported-only providers get guidance, never a fake percentage', () => {
    const s = summarizeProviderUsage({ providers: [provider('antigravity', { state: 'unsupported', guidance: { commands: ['/usage'] } })], fetchedAt: NOW });
    expect(s.kind).toBe('guidance');
    expect(s.messageKey).toBe('usage.summary_guidance');
    expect(s.limit).toBeNull();
  });

  it('no providers / no numbers => a neutral localized key', () => {
    expect(summarizeProviderUsage(null).messageKey).toBe('usage.summary_none');
    expect(summarizeProviderUsage({ providers: [], fetchedAt: NOW }).kind).toBe('none');
    expect(summarizeProviderUsage({ providers: [provider('claude', { state: 'login-required' })], fetchedAt: NOW }).messageKey).toBe('usage.summary_none');
  });
});

describe('staleAgeMinutes', () => {
  it('reports whole minutes since the data went stale, null when fresh', () => {
    expect(staleAgeMinutes(provider('claude', { state: 'stale', staleSince: NOW - 185_000 }), NOW)).toBe(3);
    expect(staleAgeMinutes(provider('claude'), NOW)).toBeNull();
    expect(staleAgeMinutes(provider('claude', { state: 'stale' }), NOW)).toBeNull();
  });
});
