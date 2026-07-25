// src/main/claudeUsage.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import { parseClaudeUsageResponse, type ProviderUsage } from '../shared/usageWindows';

const API_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface Credentials { accessToken: string; subscriptionType: string; expiresAt: number | null; }
export interface FetchResult { ok: boolean; body?: unknown; status?: number; }

export interface UsageDeps {
  now: () => number;
  env: Record<string, string | undefined>;
  readCredentials: () => Credentials | null;
  fetchUsage: (accessToken: string) => Promise<FetchResult>;
}

function planName(subscriptionType: string): string | null {
  const s = subscriptionType.toLowerCase();
  // Surface the Max tier (5x / 20x) when Anthropic encodes it in subscriptionType
  // (e.g. "max_20x", "max5x"). The usage %s are already relative to the actual tier
  // limit, so this only refines the label; plain "max" stays "Max".
  if (s.includes('max')) {
    const tier = s.match(/(\d+)\s*x/);
    return tier ? `Max ${tier[1]}x` : 'Max';
  }
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

function result(state: ProviderUsage['state'], now: number, over: Partial<ProviderUsage> = {}): ProviderUsage {
  return { providerId: 'claude', state, planLabel: null, limits: [], credits: null, guidance: null, fetchedAt: now, ...over };
}

/**
 * One live read of Claude's subscription limits, normalized. Caching, staleness, and cross-provider
 * orchestration belong to the usage coordinator — this stays a pure "what is true right now" call so
 * a failure can never overwrite last-good data on its own.
 *
 * The OAuth token never leaves this module: it goes straight from `readCredentials` into the request
 * headers, and only normalized numbers cross back.
 */
export async function getClaudeUsage(deps: UsageDeps): Promise<ProviderUsage> {
  const now = deps.now();
  if (usesCustomEndpoint(deps.env)) return result('not-applicable', now);

  const creds = deps.readCredentials();
  if (!creds) return result('login-required', now);
  if (creds.expiresAt != null && creds.expiresAt <= now) return result('expired', now);

  const plan = planName(creds.subscriptionType);
  if (!plan) return result('not-applicable', now); // API / custom-key mode has no subscription windows

  const res = await deps.fetchUsage(creds.accessToken);
  if (!res.ok) {
    // 401 = token rejected server-side (expired/invalid) → re-login; 429 = usage-API rate limit.
    return result(res.status === 401 ? 'expired' : res.status === 429 ? 'rate-limited' : 'offline', now, { planLabel: plan });
  }
  const parsed = parseClaudeUsageResponse(res.body);
  if (!parsed) return result('offline', now, { planLabel: plan });
  return result('ready', now, { planLabel: plan, limits: parsed.limits, credits: parsed.credits });
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
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        // A runaway/hostile response must not be buffered without bound.
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(); resolve({ ok: false, status: 0 }); return; }
        data += c.toString();
      });
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
