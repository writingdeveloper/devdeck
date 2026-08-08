import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanCodexUsage } from './codexUsageScan';

let root: string;
let sessionsDir: string;
let cachePath: string;
const ID = '11111111-1111-1111-1111-111111111111';
const PROJECT = 'C:\\repo\\devdeck';

const json = (value: unknown): string => JSON.stringify(value);
const meta = (cwd = PROJECT): string => json({ type: 'session_meta', timestamp: '2026-08-08T10:00:00.000Z', payload: { id: ID, cwd } });
const context = (model = 'gpt-5.6-sol'): string => json({ type: 'turn_context', timestamp: '2026-08-08T10:00:10.000Z', payload: { model } });
const activity = (timestamp: string): string => json({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'not retained' } });
const token = (total: Record<string, number>, last: Record<string, number>, timestamp: string): string => json({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
});

function rolloutPath(): string {
  const file = join(sessionsDir, '2026', '08', '08', `rollout-${ID}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

function firstRollout(cwd = PROJECT): string[] {
  const usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 10 };
  return [meta(cwd), context(), activity('2026-08-08T10:00:00.000Z'), token(usage, usage, '2026-08-08T10:01:00.000Z')];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdeck-codex-usage-'));
  sessionsDir = join(root, 'sessions');
  cachePath = join(root, 'cache', 'codex-usage-index.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe('scanCodexUsage', () => {
  it('streams a rollout into project, model, day, token, and cost aggregates', async () => {
    writeFileSync(rolloutPath(), firstRollout().join('\n') + '\n');
    const report = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity, exists: () => true });

    expect(report.providerId).toBe('codex');
    expect(report.state).toBe('ready');
    expect(report.global).toEqual({ input: 40, cacheRead: 60, cacheWrite: 0, output: 10 });
    expect(report.globalCost).toBeCloseTo((40 * 5 + 60 * 0.5 + 10 * 30) / 1_000_000, 8);
    expect(report.byProject[0]).toMatchObject({ path: PROJECT, name: 'devdeck', sessions: 1, status: 'active' });
    expect(report.byModel[0]).toMatchObject({ providerId: 'codex', model: 'gpt-5.6-sol' });
    expect(report.daily).toEqual([expect.objectContaining({ day: '2026-08-08', tokens: 110 })]);
  });

  it('reads only appended bytes and reads nothing on an unchanged refresh', async () => {
    const file = rolloutPath();
    writeFileSync(file, firstRollout().join('\n') + '\n');
    await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });

    let unchangedBytes = 0;
    const unchanged = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity, onBytesRead: (n) => { unchangedBytes += n; } });
    expect(unchanged.global.input).toBe(40);
    expect(unchangedBytes).toBe(0);

    const nextTotal = { input_tokens: 150, cached_input_tokens: 70, cache_write_input_tokens: 0, output_tokens: 15 };
    const nextLast = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 };
    appendFileSync(file, token(nextTotal, nextLast, '2026-08-08T10:03:00.000Z') + '\n');
    let appendBytes = 0;
    const appended = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity, onBytesRead: (n) => { appendBytes += n; } });
    expect(appended.global).toEqual({ input: 80, cacheRead: 70, cacheWrite: 0, output: 15 });
    expect(appendBytes).toBeGreaterThan(0);
    expect(appendBytes).toBeLessThan(Buffer.byteLength(firstRollout().join('\n') + '\n' + token(nextTotal, nextLast, '2026-08-08T10:03:00.000Z') + '\n'));
  });

  it('keeps an incomplete trailing line until the line is finished', async () => {
    const file = rolloutPath();
    const base = firstRollout().join('\n') + '\n';
    const next = token(
      { input_tokens: 120, cached_input_tokens: 65, output_tokens: 12 },
      { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 },
      '2026-08-08T10:03:00.000Z',
    );
    const cut = Math.floor(next.length / 2);
    writeFileSync(file, base + next.slice(0, cut));
    const partial = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(partial.global.output).toBe(10);

    appendFileSync(file, next.slice(cut) + '\n');
    const completed = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(completed.global.output).toBe(12);
  });

  it('rebuilds one file after truncation instead of retaining old totals', async () => {
    const file = rolloutPath();
    writeFileSync(file, firstRollout().join('\n') + '\n');
    await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });

    const small = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 };
    writeFileSync(file, [meta(), context(), token(small, small, '2026-08-09T10:00:00.000Z')].join('\n') + '\n');
    const rebuilt = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(rebuilt.global).toEqual({ input: 15, cacheRead: 5, cacheWrite: 0, output: 2 });
    expect(rebuilt.daily.map((day) => day.day)).toEqual(['2026-08-09']);
  });

  it('discards a corrupt persisted index and reconstructs from source', async () => {
    writeFileSync(rolloutPath(), firstRollout().join('\n') + '\n');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, '{');
    const report = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(report.global.output).toBe(10);
  });

  it('rejects a structurally invalid cached cursor instead of trusting its aggregate', async () => {
    const file = rolloutPath();
    writeFileSync(file, firstRollout().join('\n') + '\n');
    const stat = statSync(file);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ version: 1, files: [{
      file, id: ID, cwd: PROJECT, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs,
      size: stat.size, offset: stat.size, discardUntilNewline: false,
      cursor: { model: 'gpt-5.6-sol', cumulative: { input_tokens: 'invalid' }, seenFallbackKeys: [] },
      buckets: [{ day: '2026-08-08', dayMs: Date.UTC(2026, 7, 8), model: 'gpt-5.6-sol', totals: { input: 999, output: 0, cacheWrite: 0, cacheRead: 0 } }],
      days: [{ day: '2026-08-08', dayMs: Date.UTC(2026, 7, 8), activeMs: 0, hadActivity: true }], lastActivityMs: null,
    }] }));

    const report = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(report.global.input).toBe(40);
  });

  it('returns an empty ready slice when no local Codex sessions exist', async () => {
    const report = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(report).toMatchObject({ providerId: 'codex', state: 'ready', sessions: 0, globalCost: null });
  });

  it('marks a project deleted when its recorded cwd no longer exists', async () => {
    writeFileSync(rolloutPath(), firstRollout('C:\\gone\\project').join('\n') + '\n');
    const report = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity, exists: () => false });
    expect(report.byProject[0].status).toBe('deleted');
  });

  it('caps idle gaps and filters sessions by day', async () => {
    const lines = [
      meta(), context(),
      activity('2026-08-08T10:00:00.000Z'),
      activity('2026-08-08T10:02:00.000Z'),
      activity('2026-08-08T10:20:00.000Z'),
      activity('2026-08-08T10:21:00.000Z'),
    ];
    writeFileSync(rolloutPath(), lines.join('\n') + '\n');
    const all = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity });
    expect(all.activeMs).toBe(3 * 60_000);
    expect(all.sessions).toBe(1);
    const later = await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Date.UTC(2026, 7, 9) });
    expect(later.sessions).toBe(0);
  });

  it('yields between bounded chunks during a large initial scan', async () => {
    writeFileSync(rolloutPath(), firstRollout().join('\n') + '\n' + ' '.repeat(2048));
    let yields = 0;
    await scanCodexUsage({ sessionsDir, cachePath, sinceMs: Infinity, chunkBytes: 128, yieldNow: async () => { yields++; } });
    expect(yields).toBeGreaterThan(1);
  });
});
