// src/main/claudeUsage.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import { parseUsageResponse, type UsageResult, type UsageWindows } from '../shared/usageWindows';

const CACHE_TTL_MS = 5 * 60_000;
const API_TIMEOUT_MS = 15_000;

export interface Credentials { accessToken: string; subscriptionType: string; expiresAt: number | null; }
export interface FetchResult { ok: boolean; body?: unknown; status?: number; }
export interface CacheEntry { timestamp: number; data: UsageWindows; }

export interface UsageDeps {
  now: () => number;
  env: Record<string, string | undefined>;
  readCredentials: () => Credentials | null;
  fetchUsage: (accessToken: string) => Promise<FetchResult>;
  cacheRead: () => CacheEntry | null;
  cacheWrite: (e: CacheEntry) => void;
}

function planName(subscriptionType: string): string | null {
  const s = subscriptionType.toLowerCase();
  if (s.includes('max')) return 'Max';
  if (s.includes('pro')) return 'Pro';
  if (s.includes('team')) return 'Team';
  if (!s || s.includes('api')) return null; // API users: feature not applicable
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

function usesCustomEndpoint(env: Record<string, string | undefined>): boolean {
  const base = env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_API_BASE_URL?.trim();
  if (!base) return false;
  try { return new URL(base).origin !== 'https://api.anthropic.com'; } catch { return true; }
}

export async function getUsageWindows(deps: UsageDeps): Promise<UsageResult> {
  const now = deps.now();
  if (usesCustomEndpoint(deps.env)) return { enabled: true, error: 'not-applicable' };

  const fresh = deps.cacheRead();
  if (fresh && now - fresh.timestamp < CACHE_TTL_MS) return { enabled: true, data: fresh.data };

  const creds = deps.readCredentials();
  if (!creds) return { enabled: true, error: 'no-credentials' };
  if (creds.expiresAt != null && creds.expiresAt <= now) return { enabled: true, error: 'expired' };

  const plan = planName(creds.subscriptionType);
  if (!plan) return { enabled: true, error: 'not-applicable' };

  const res = await deps.fetchUsage(creds.accessToken);
  if (!res.ok) {
    // On any failure, fall back to last-good cache (even if stale) so the bar stays useful.
    if (fresh) return { enabled: true, data: fresh.data };
    return { enabled: true, error: res.status === 429 ? 'rate-limited' : 'offline' };
  }
  const parsed = parseUsageResponse(res.body);
  if (!parsed) {
    if (fresh) return { enabled: true, data: fresh.data };
    return { enabled: true, error: 'offline' };
  }
  const data: UsageWindows = { planName: plan, ...parsed };
  deps.cacheWrite({ timestamp: now, data });
  return { enabled: true, data };
}

// ---- Production deps (not unit-tested; thin I/O wrappers) ----

export function readClaudeCredentials(home = homedir()): Credentials | null {
  try {
    const raw = readFileSync(join(home, '.claude', '.credentials.json'), 'utf8');
    const o = (JSON.parse(raw)?.claudeAiOauth ?? {}) as Record<string, unknown>;
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken : '';
    if (!accessToken) return null;
    return {
      accessToken,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : '',
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
    };
  } catch { return null; }
}

export function fetchUsageApi(accessToken: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: API_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve({ ok: false, status: res.statusCode }); return; }
        try { resolve({ ok: true, body: JSON.parse(data) }); } catch { resolve({ ok: false, status: 0 }); }
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}
