// src/main/codexUsage.ts
// Live Codex subscription limits via the INSTALLED official `codex app-server`. DevDeck never reads,
// stores, or exports Codex credentials — the app-server owns authentication and makes its own
// first-party request; we only speak its JSON-RPC and normalize the answer.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { clampPercent, parseResetTime, safeUsageLabel, type ProviderUsage, type UsageCredits, type UsageLimit } from '../shared/usageWindows';

const STARTUP_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;

export interface CodexUsageDeps {
  now: () => number;
  spawnAppServer: () => ChildProcessWithoutNullStreams;
  clientVersion: string;
  /** Injected in tests so timers don't depend on real time. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function result(state: ProviderUsage['state'], now: number, over: Partial<ProviderUsage> = {}): ProviderUsage {
  return { providerId: 'codex', state, planLabel: null, limits: [], credits: null, guidance: null, fetchedAt: now, ...over };
}

/** The app-server sends `resetsAt` as an epoch NUMBER (seconds today, ms on other builds), not the
 *  ISO string Claude uses — treat anything below year-2286-in-seconds as seconds. */
function epochToMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
}

/** `balance` arrives as a string ("0") on the current app-server; accept both. */
function numberish(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Codex names its windows only by position ("primary"/"secondary"), but it also reports how long each
 *  one lasts — so when the duration is a window the user already has a word for, use that word. The
 *  live `primary` is 10080 min, i.e. weekly: "기본 한도" told the user nothing that "주간" doesn't. */
const DURATION_LABEL: Record<number, string> = {
  300: 'usage.limit_session',   // 5h
  1440: 'usage.limit_daily',    // 24h
  10080: 'usage.limit_weekly',  // 7d
};

function durationLabel(w: Record<string, unknown>): string | null {
  const mins = w.window_duration_mins ?? w.windowDurationMins ?? w.window_minutes ?? w.windowMinutes;
  return typeof mins === 'number' && Number.isFinite(mins) ? DURATION_LABEL[mins] ?? null : null;
}

function windowLimit(raw: unknown, kind: 'primary' | 'secondary', now: number): UsageLimit | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const percent = clampPercent(w.used_percent ?? w.usedPercent ?? w.utilization ?? w.percent);
  // `resetsAt` as epoch number or ISO string, or `resets_in_seconds` relative — all seen in the wild.
  const seconds = w.resets_in_seconds ?? w.resetsInSeconds;
  const resetAt = parseResetTime(w.resets_at ?? w.resetsAt)
    ?? epochToMs(w.resets_at ?? w.resetsAt)
    ?? (typeof seconds === 'number' && Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : null);
  if (percent == null && resetAt == null) return null;
  return {
    id: `codex:${kind}`,
    kind,
    label: durationLabel(w) ?? (kind === 'primary' ? 'usage.limit_primary' : 'usage.limit_secondary'),
    percent,
    resetAt,
    modelLabel: null,
  };
}

/** Credits ride INSIDE the rate-limit snapshot on the current app-server, and at the top level on
 *  older ones — check both rather than silently dropping the block. */
function credits(...sources: Record<string, unknown>[]): UsageCredits | null {
  const raw = sources.find((s) => s && (s.credits ?? s.creditBalance ?? s.credit_balance) != null);
  if (!raw) return null;
  const c = (raw.credits ?? raw.creditBalance ?? raw.credit_balance) as Record<string, unknown> | number | undefined;
  if (typeof c === 'number' && Number.isFinite(c)) return { hasCredits: c > 0, balance: c, spent: null, currency: null };
  if (!c || typeof c !== 'object') return null;
  const out: UsageCredits = {
    // `hasCredits` is the account's own flag; `unlimited` is a separate concept and only stands in
    // when the flag is absent.
    hasCredits: typeof c.has_credits === 'boolean' ? c.has_credits
      : typeof c.hasCredits === 'boolean' ? c.hasCredits
        : typeof c.unlimited === 'boolean' ? c.unlimited : null,
    balance: numberish(c.balance ?? c.remaining),
    spent: numberish(c.spent ?? c.used),
    currency: typeof c.currency === 'string' ? c.currency.trim().slice(0, 8) : null,
  };
  return out.hasCredits == null && out.balance == null && out.spent == null ? null : out;
}

/**
 * Normalize an `account/rateLimits/read` result. Returns `not-applicable` (not an error) for modes
 * with no subscription windows — API key, local model, or a plain logged-in account without a plan.
 */
export function parseCodexRateLimits(value: unknown, now: number): ProviderUsage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const snapshot = (v.rate_limits ?? v.rateLimits ?? v) as Record<string, unknown>;
  const limits = [
    windowLimit(snapshot.primary ?? snapshot.primary_window, 'primary', now),
    windowLimit(snapshot.secondary ?? snapshot.secondary_window, 'secondary', now),
  ].filter((l): l is UsageLimit => !!l);
  const plan = v.plan_type ?? v.planType ?? snapshot.plan_type ?? snapshot.planType;
  const planLabel = typeof plan === 'string' && plan.trim() ? safeUsageLabel(plan, 'Codex') : null;
  const cr = credits(snapshot, v);
  if (!limits.length && !cr) return result('not-applicable', now, { planLabel });
  return result('ready', now, { planLabel, limits, credits: cr });
}

/**
 * Start `codex app-server`, perform the required initialize/initialized handshake, read the account's
 * rate limits, and shut the child down exactly once. Bounded on every axis: startup timeout, request
 * timeout, and a hard cap on captured output.
 */
export function getCodexUsage(deps: CodexUsageDeps): Promise<ProviderUsage> {
  const now = deps.now();
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return new Promise<ProviderUsage>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = deps.spawnAppServer(); } catch { resolve(result('cli-missing', now)); return; }

    let settled = false;
    let killed = false;
    let buffer = '';
    let bytes = 0;
    let timer: unknown = setTimer(() => finish(result('offline', now)), STARTUP_TIMEOUT_MS);

    // Single exit path: clears the timer, detaches listeners, closes stdin, and kills at most once.
    const finish = (value: ProviderUsage): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      try { child.stdin?.end(); } catch { /* already closed */ }
      if (!killed) { killed = true; try { child.kill(); } catch { /* already gone */ } }
      resolve(value);
    };

    const send = (msg: unknown): void => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { finish(result('offline', now)); }
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(result(err && err.code === 'ENOENT' ? 'cli-missing' : 'offline', now));
    });
    child.on('exit', () => finish(result('offline', now))); // exited before answering

    child.stderr?.on('data', () => { /* app-server logs go to stderr; never part of the answer */ });

    child.stdout.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { finish(result('offline', now)); return; }
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
        if (settled) return;
        nl = buffer.indexOf('\n');
      }
    });

    function handleLine(line: string): void {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; } // notification noise / partial junk
      const id = msg.id;
      if (id === INITIALIZE_ID) {
        if (msg.error) { finish(loginOrOffline(msg.error, now)); return; }
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        clearTimer(timer);
        timer = setTimer(() => finish(result('offline', now)), REQUEST_TIMEOUT_MS);
        send({ jsonrpc: '2.0', id: RATE_LIMITS_ID, method: 'account/rateLimits/read', params: {} });
        return;
      }
      if (id === RATE_LIMITS_ID) {
        if (msg.error) { finish(loginOrOffline(msg.error, now)); return; }
        finish(parseCodexRateLimits(msg.result, now) ?? result('offline', now));
      }
      // Everything else (notifications, unrelated ids) is ignored by design.
    }

    send({ jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'devdeck', version: deps.clientVersion } } });
  });
}

/** An auth/login complaint is actionable ("run codex login"); anything else is just a failed read. */
function loginOrOffline(error: unknown, now: number): ProviderUsage {
  const text = typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  return result(/auth|login|unauthor|credential|sign in/i.test(text) ? 'login-required' : 'offline', now);
}

/** Production spawn: the official CLI, stdio pipes only, no shell. */
export function spawnCodexAppServer(): ChildProcessWithoutNullStreams {
  return spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams;
}
