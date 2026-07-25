// src/shared/usagePresentation.test.ts
import { describe, it, expect } from 'vitest';
import { criticalUsageLimit, mostUrgentLimit, summarizeProviderUsage, staleAgeMinutes } from './usagePresentation';
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

describe("summarizeProviderUsage with an active provider (the selected session's)", () => {
  const snapshot = {
    providers: [
      provider('claude', { limits: [limit('c-5h', 40)] }),
      provider('codex', { limits: [limit('x-primary', 91)] }),
    ],
    fetchedAt: NOW,
  };

  it('reports the ACTIVE provider, not the cross-provider maximum', () => {
    const s = summarizeProviderUsage(snapshot, 'claude');
    expect(s).toMatchObject({ kind: 'limit', providerId: 'claude', severity: 'ok' });
    expect(s.limit!.percent).toBe(40);
  });

  it('switches with the session (the same snapshot, the other provider)', () => {
    const s = summarizeProviderUsage(snapshot, 'codex');
    expect(s).toMatchObject({ kind: 'limit', providerId: 'codex', severity: 'crit' });
    expect(s.limit!.percent).toBe(91);
  });

  it('falls back to the cross-provider maximum when no session is selected', () => {
    expect(summarizeProviderUsage(snapshot, null).providerId).toBe('codex');
  });

  it('falls back when the active provider is not in the snapshot (not installed)', () => {
    expect(summarizeProviderUsage(snapshot, 'antigravity').providerId).toBe('codex');
  });

  it("explains the active provider's own state instead of showing another provider's number", () => {
    const s = summarizeProviderUsage({
      providers: [provider('claude', { state: 'login-required' }), provider('codex', { limits: [limit('x', 91)] })],
      fetchedAt: NOW,
    }, 'claude');
    expect(s.kind).toBe('none');
    expect(s.providerId).toBe('claude');
    expect(s.messageKey).toBe('usage.state_login_required');
    expect(s.limit).toBeNull();
  });

  it('gives CLI guidance when the active provider cannot be read programmatically', () => {
    const s = summarizeProviderUsage({
      providers: [provider('antigravity', { state: 'unsupported', guidance: { commands: ['/usage'] } }), provider('claude', { limits: [limit('c', 12)] })],
      fetchedAt: NOW,
    }, 'antigravity');
    expect(s).toMatchObject({ kind: 'guidance', providerId: 'antigravity', messageKey: 'usage.summary_guidance' });
  });
});

describe('mostUrgentLimit', () => {
  it('picks the highest percentage within one provider, ignoring null percentages', () => {
    expect(mostUrgentLimit(provider('claude', { limits: [limit('a', 12), limit('b', null), limit('c', 66)] }))!.id).toBe('c');
  });

  it('returns null for a provider with no numeric state', () => {
    expect(mostUrgentLimit(provider('claude', { state: 'offline', limits: [limit('a', 50)] }))).toBeNull();
  });
});

describe('staleAgeMinutes', () => {
  it('reports whole minutes since the data went stale, null when fresh', () => {
    expect(staleAgeMinutes(provider('claude', { state: 'stale', staleSince: NOW - 185_000 }), NOW)).toBe(3);
    expect(staleAgeMinutes(provider('claude'), NOW)).toBeNull();
    expect(staleAgeMinutes(provider('claude', { state: 'stale' }), NOW)).toBeNull();
  });
});
