// src/main/codexUsage.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { getCodexUsage, parseCodexRateLimits, type CodexUsageDeps } from './codexUsage';

const NOW = 1_700_000_000_000;

/** A fake `codex app-server`: real streams both ways, plus a kill spy and a pending-timer queue. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const written: string[] = [];
  child.stdin.on('data', (c) => written.push(c.toString()));
  return { child, written };
}

function harness(over: Partial<CodexUsageDeps> = {}) {
  const { child, written } = fakeChild();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const deps: CodexUsageDeps = {
    now: () => NOW,
    clientVersion: '1.22.1',
    spawnAppServer: () => child as never,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    ...over,
  };
  return { child, written, timers, run: () => getCodexUsage(deps) };
}

const messages = (written: string[]): Array<Record<string, unknown>> =>
  written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Wait for the harness to have written the handshake before answering it. */
const tick = () => new Promise((r) => setImmediate(r));

describe('parseCodexRateLimits', () => {
  it('normalizes primary + secondary windows and the plan', () => {
    const r = parseCodexRateLimits({
      plan_type: 'plus',
      rate_limits: {
        primary: { used_percent: 42.4, resets_in_seconds: 3600 },
        secondary: { used_percent: 7, resets_at: '2026-06-20T00:00:00Z' },
      },
    }, NOW)!;
    expect(r.state).toBe('ready');
    expect(r.planLabel).toBe('plus');
    expect(r.limits.map((l) => [l.kind, l.id, l.percent])).toEqual([
      ['primary', 'codex:primary', 42],
      ['secondary', 'codex:secondary', 7],
    ]);
    expect(r.limits[0].resetAt).toBe(NOW + 3_600_000);
    expect(r.limits[1].resetAt).toBe(Date.parse('2026-06-20T00:00:00Z'));
  });

  it('reads credits, including an unlimited flag', () => {
    expect(parseCodexRateLimits({ rate_limits: { primary: { used_percent: 1 } }, credits: { balance: 5.5, spent: 1, currency: 'USD' } }, NOW)!.credits)
      .toEqual({ hasCredits: null, balance: 5.5, spent: 1, currency: 'USD' });
    expect(parseCodexRateLimits({ rate_limits: { primary: { used_percent: 1 } }, credits: { unlimited: true } }, NOW)!.credits?.hasCredits).toBe(true);
  });

  // Verbatim shape from a live `codex app-server` (2026-07): camelCase, an epoch-SECONDS resetsAt,
  // a null secondary window, and a credit balance delivered as a STRING.
  it('parses a real app-server response', () => {
    const r = parseCodexRateLimits({
      rateLimits: {
        limitId: 'codex', limitName: null,
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1785460409 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        individualLimit: null, spendControlReached: false, planType: 'plus', rateLimitReachedType: 'rate_limit_reached',
      },
    }, NOW)!;
    expect(r.state).toBe('ready');
    expect(r.planLabel).toBe('plus');
    expect(r.limits).toHaveLength(1);
    expect(r.limits[0]).toMatchObject({ kind: 'primary', percent: 100, resetAt: 1785460409_000 });
    expect(r.credits).toEqual({ hasCredits: false, balance: 0, spent: null, currency: null });
  });

  it('accepts epoch seconds or milliseconds for resetsAt', () => {
    const sec = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, resetsAt: 1785460409 } } }, NOW)!;
    const ms = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, resetsAt: 1785460409_000 } } }, NOW)!;
    expect(sec.limits[0].resetAt).toBe(1785460409_000);
    expect(ms.limits[0].resetAt).toBe(1785460409_000);
  });

  it('API-key / no-subscription mode is not-applicable, not an error', () => {
    const r = parseCodexRateLimits({ plan_type: null, rate_limits: {} }, NOW)!;
    expect(r.state).toBe('not-applicable');
    expect(r.limits).toEqual([]);
  });

  it('drops malformed percentages and invalid resets instead of surfacing them', () => {
    const r = parseCodexRateLimits({ rate_limits: { primary: { used_percent: 'nope', resets_at: 'later' }, secondary: { used_percent: 250 } } }, NOW)!;
    expect(r.limits.map((l) => [l.kind, l.percent, l.resetAt])).toEqual([['secondary', 100, null]]);
  });

  it('keeps unknown response fields out of the normalized result', () => {
    const r = parseCodexRateLimits({ rate_limits: { primary: { used_percent: 3 } }, account_id: 'acct_secret', token: 'sk-x' }, NOW)!;
    expect(JSON.stringify(r)).not.toContain('acct_secret');
    expect(JSON.stringify(r)).not.toContain('sk-x');
  });

  it('null on a non-object result', () => {
    expect(parseCodexRateLimits(null, NOW)).toBeNull();
    expect(parseCodexRateLimits('x', NOW)).toBeNull();
  });

  // Pinned to a REAL `account/rateLimits/read` result (2026-07-25): one window, 10080 min = weekly.
  it('labels a window by its reported duration instead of its position', () => {
    const live = parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1785612762 },
        secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus',
      },
    }, NOW)!;
    expect(live.limits).toHaveLength(1);
    expect(live.limits[0]).toMatchObject({ id: 'codex:primary', kind: 'primary', label: 'usage.limit_weekly', percent: 12 });
    expect(live.planLabel).toBe('plus');
  });

  it('falls back to the positional label for a duration with no name of its own', () => {
    const r = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: { usedPercent: 2, windowDurationMins: 77 } } }, NOW)!;
    expect(r.limits.map((l) => l.label)).toEqual(['usage.limit_session', 'usage.limit_secondary']);
  });
});

describe('getCodexUsage protocol', () => {
  it('sends initialize, initialized, then account/rateLimits/read in order', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rate_limits: { primary: { used_percent: 12 } } } })}\n`);
    const r = await p;

    expect(messages(h.written)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'devdeck', version: '1.22.1' } } },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} },
    ]);
    expect(r.state).toBe('ready');
    expect(r.limits[0].percent).toBe(12);
    expect(h.child.kill).toHaveBeenCalledTimes(1);
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it('ignores interleaved notifications and unrelated ids, and tolerates split chunks', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/event', params: { x: 1 } })}\n`);
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, result: { nope: true } })}\n`);
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    await tick();
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rate_limits: { primary: { used_percent: 30 } } } });
    h.child.stdout.write(payload.slice(0, 20)); // split mid-message
    h.child.stdout.write(`${payload.slice(20)}\n`);
    expect((await p).limits[0].percent).toBe(30);
  });

  it('malformed JSON lines and stderr noise never resolve the read', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stderr.write('warning: something\n');
    h.child.stdout.write('{not json\n');
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rate_limits: { secondary: { used_percent: 4 } } } })}\n`);
    expect((await p).state).toBe('ready');
  });

  it('missing CLI (ENOENT) => cli-missing', async () => {
    const h = harness();
    const p = h.run();
    h.child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    const r = await p;
    expect(r.state).toBe('cli-missing');
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });

  it('a spawn that throws outright => cli-missing without a dangling promise', async () => {
    const r = await getCodexUsage({ now: () => NOW, clientVersion: '1', spawnAppServer: () => { throw new Error('no'); } });
    expect(r.state).toBe('cli-missing');
  });

  it('startup timeout => offline, child killed once', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    expect(h.timers[0].ms).toBe(8_000);
    h.timers[0].fn();
    expect((await p).state).toBe('offline');
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });

  it('read timeout after a successful handshake => offline', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    await tick();
    const readTimer = h.timers.at(-1)!;
    expect(readTimer.ms).toBe(12_000);
    readTimer.fn();
    expect((await p).state).toBe('offline');
  });

  it('an auth error maps to login-required, other errors to offline', async () => {
    const auth = harness();
    const pAuth = auth.run();
    await tick();
    auth.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'not authenticated, run codex login' } })}\n`);
    expect((await pAuth).state).toBe('login-required');

    const other = harness();
    const pOther = other.run();
    await tick();
    other.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'internal failure' } })}\n`);
    expect((await pOther).state).toBe('offline');
  });

  it('an early exit resolves offline instead of hanging', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.emit('exit', 1);
    expect((await p).state).toBe('offline');
  });

  it('output beyond the cap aborts the read', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stdout.write('x'.repeat(256 * 1024 + 1));
    expect((await p).state).toBe('offline');
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });

  it('late output after settling cannot resolve twice or kill twice', async () => {
    const h = harness();
    const p = h.run();
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    await tick();
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rate_limits: { primary: { used_percent: 8 } } } })}\n`);
    await p;
    h.child.emit('exit', 0);
    h.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rate_limits: { primary: { used_percent: 99 } } } })}\n`);
    expect((await p).limits[0].percent).toBe(8);
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
});
