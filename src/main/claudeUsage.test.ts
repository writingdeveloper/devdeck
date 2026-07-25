// src/main/claudeUsage.test.ts
import { describe, it, expect } from 'vitest';
import { getClaudeUsage, type UsageDeps } from './claudeUsage';

const ISO = '2026-06-15T14:32:00Z';
const baseCreds = { accessToken: 'tok-secret', subscriptionType: 'max', expiresAt: 9_999_999_999_999 };

function deps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    now: () => 1000,
    env: {},
    readCredentials: () => baseCreds,
    fetchUsage: async () => ({ ok: true, body: { five_hour: { utilization: 18, resets_at: ISO }, seven_day: { utilization: 31, resets_at: ISO } } }),
    ...over,
  };
}

describe('getClaudeUsage', () => {
  it('returns normalized limits + plan from a fresh fetch', async () => {
    const r = await getClaudeUsage(deps());
    expect(r.providerId).toBe('claude');
    expect(r.state).toBe('ready');
    expect(r.planLabel).toBe('Max');
    expect(r.limits.map((l) => [l.kind, l.percent])).toEqual([['session', 18], ['weekly', 31]]);
    expect(r.fetchedAt).toBe(1000);
  });

  it('never leaks the access token in the result', async () => {
    expect(JSON.stringify(await getClaudeUsage(deps()))).not.toContain('tok-secret');
  });

  it('surfaces the Max tier from subscriptionType when encoded', async () => {
    expect((await getClaudeUsage(deps({ readCredentials: () => ({ ...baseCreds, subscriptionType: 'max_20x' }) }))).planLabel).toBe('Max 20x');
    expect((await getClaudeUsage(deps({ readCredentials: () => ({ ...baseCreds, subscriptionType: 'max5x' }) }))).planLabel).toBe('Max 5x');
    expect((await getClaudeUsage(deps({ readCredentials: () => ({ ...baseCreds, subscriptionType: 'max' }) }))).planLabel).toBe('Max');
  });

  it('carries model-scoped weekly limits and credits through', async () => {
    const r = await getClaudeUsage(deps({
      fetchUsage: async () => ({ ok: true, body: {
        limits: [
          { type: 'five_hour', utilization: 9, resets_at: ISO },
          { type: 'seven_day', utilization: 55, resets_at: ISO, model: 'fable-5', model_display_name: 'Fable 5' },
        ],
        extra_usage: { has_credits: true, balance: 8, spent: 2, currency: 'USD' },
      } }),
    }));
    expect(r.limits.find((l) => l.kind === 'model-weekly')?.modelLabel).toBe('Fable 5');
    expect(r.credits).toEqual({ hasCredits: true, balance: 8, spent: 2, currency: 'USD' });
  });

  it('no credentials => login-required', async () => {
    expect((await getClaudeUsage(deps({ readCredentials: () => null }))).state).toBe('login-required');
  });

  it('locally expired token => expired (the coordinator keeps showing last-good)', async () => {
    expect((await getClaudeUsage(deps({ readCredentials: () => ({ ...baseCreds, expiresAt: 500 }) }))).state).toBe('expired');
  });

  it('api subscription => not-applicable', async () => {
    expect((await getClaudeUsage(deps({ readCredentials: () => ({ ...baseCreds, subscriptionType: 'api' }) }))).state).toBe('not-applicable');
  });

  it('custom endpoint => not-applicable and no fetch at all', async () => {
    let fetched = false;
    const r = await getClaudeUsage(deps({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example' }, fetchUsage: async () => { fetched = true; return { ok: false, status: 0 }; } }));
    expect(fetched).toBe(false);
    expect(r.state).toBe('not-applicable');
  });

  it('maps HTTP failures: 401 => expired, 429 => rate-limited, other => offline', async () => {
    expect((await getClaudeUsage(deps({ fetchUsage: async () => ({ ok: false, status: 401 }) }))).state).toBe('expired');
    expect((await getClaudeUsage(deps({ fetchUsage: async () => ({ ok: false, status: 429 }) }))).state).toBe('rate-limited');
    expect((await getClaudeUsage(deps({ fetchUsage: async () => ({ ok: false, status: 500 }) }))).state).toBe('offline');
  });

  it('unparseable body => offline with no partial limits', async () => {
    const r = await getClaudeUsage(deps({ fetchUsage: async () => ({ ok: true, body: 'nonsense' }) }));
    expect(r.state).toBe('offline');
    expect(r.limits).toEqual([]);
  });
});
