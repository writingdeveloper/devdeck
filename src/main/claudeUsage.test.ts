// src/main/claudeUsage.test.ts
import { describe, it, expect } from 'vitest';
import { getUsageWindows, type UsageDeps } from './claudeUsage';

const ISO = '2026-06-15T14:32:00Z';
const baseCreds = { accessToken: 'tok-secret', subscriptionType: 'max', expiresAt: 9_999_999_999_999 };

function deps(over: Partial<UsageDeps> = {}): UsageDeps {
  let cache: any = null;
  return {
    now: () => 1000,
    env: {},
    readCredentials: () => baseCreds,
    fetchUsage: async () => ({ ok: true, body: { five_hour: { utilization: 18, resets_at: ISO }, seven_day: { utilization: 31, resets_at: ISO } } }),
    cacheRead: () => cache,
    cacheWrite: (c: any) => { cache = c; },
    ...over,
  };
}

describe('getUsageWindows', () => {
  it('returns data + plan from a fresh fetch', async () => {
    const r = await getUsageWindows(deps());
    expect(r).toEqual({ enabled: true, data: { planName: 'Max', fiveHour: 18, sevenDay: 31, fiveHourResetAt: Date.parse(ISO), sevenDayResetAt: Date.parse(ISO) } });
  });

  it('never leaks the access token in the result', async () => {
    const r = await getUsageWindows(deps());
    expect(JSON.stringify(r)).not.toContain('tok-secret');
  });

  it('no credentials => error no-credentials', async () => {
    const r = await getUsageWindows(deps({ readCredentials: () => null }));
    expect(r).toEqual({ enabled: true, error: 'no-credentials' });
  });

  it('expired token => error expired', async () => {
    const r = await getUsageWindows(deps({ readCredentials: () => ({ ...baseCreds, expiresAt: 500 }) }));
    expect(r).toEqual({ enabled: true, error: 'expired' });
  });

  it('api subscription => not-applicable', async () => {
    const r = await getUsageWindows(deps({ readCredentials: () => ({ ...baseCreds, subscriptionType: 'api' }) }));
    expect(r).toEqual({ enabled: true, error: 'not-applicable' });
  });

  it('custom endpoint => not-applicable (no fetch)', async () => {
    let fetched = false;
    const r = await getUsageWindows(deps({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example' }, fetchUsage: async () => { fetched = true; return { ok: false, status: 0 }; } }));
    expect(fetched).toBe(false);
    expect(r).toEqual({ enabled: true, error: 'not-applicable' });
  });

  it('serves cache when fresh (<5min) without fetching', async () => {
    let calls = 0;
    const cached = { timestamp: 1000, data: { planName: 'Max', fiveHour: 5, sevenDay: 5, fiveHourResetAt: 1, sevenDayResetAt: 1 } };
    const r = await getUsageWindows(deps({ now: () => 1000 + 4 * 60_000, cacheRead: () => cached, fetchUsage: async () => { calls++; return { ok: true, body: {} }; } }));
    expect(calls).toBe(0);
    expect(r).toEqual({ enabled: true, data: cached.data });
  });

  it('rate-limited => serves last-good if present else error', async () => {
    const cached = { timestamp: 1000, data: { planName: 'Max', fiveHour: 7, sevenDay: 9, fiveHourResetAt: 1, sevenDayResetAt: 1 } };
    const r = await getUsageWindows(deps({ now: () => 1000 + 10 * 60_000, cacheRead: () => cached, fetchUsage: async () => ({ ok: false, status: 429 }) }));
    expect(r).toEqual({ enabled: true, data: cached.data });
  });

  it('offline with no cache => error offline', async () => {
    const r = await getUsageWindows(deps({ fetchUsage: async () => ({ ok: false, status: 0 }) }));
    expect(r).toEqual({ enabled: true, error: 'offline' });
  });
});
