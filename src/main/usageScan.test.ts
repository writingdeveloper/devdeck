import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanUsage, _cacheHasFile, _clearFileCache, _setCacheBudget, MAX_CACHED_FILE_BYTES } from './usageScan';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-usage-')); _clearFileCache(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function asst(model: string, u: Record<string, number>, ts = '2026-06-01T10:00:00.000Z') {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage: u } });
}

describe('scanUsage', () => {
  it('aggregates per-project, per-model, and global totals with cost', async () => {
    const d = join(root, 'C--g-proj');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's1.jsonl'), [
      asst('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      asst('claude-opus-4-8', { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n'));

    const r = await scanUsage([{ path: 'C:\\g\\proj', name: 'proj' }], root, Infinity);
    expect(r.global.input).toBe(1_000_000);
    expect(r.global.output).toBe(1_000_000);
    expect(r.byProject[0].name).toBe('proj');
    expect(r.byProject[0].sessions).toBe(1);
    expect(r.globalCost).toBeCloseTo(5 + 25, 3);          // 1M input @ $5 + 1M output @ $25
    expect(r.byProject[0].costEstimate).toBeCloseTo(5 + 25, 3);
    expect(r.byModel.find((m) => m.model === 'claude-opus-4-8')).toBeTruthy();
  });

  it('flags unknown models (tokens counted, no cost) and bins daily', async () => {
    const d = join(root, 'C--g-x');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's.jsonl'), asst('mystery-model', { input_tokens: 5 }, '2026-05-30T00:00:00.000Z'));
    const r = await scanUsage([{ path: 'C:\\g\\x', name: 'x' }], root, Infinity);
    expect(r.hasUnknownModel).toBe(true);
    expect(r.global.input).toBe(5);
    expect(r.byProject[0].costEstimate).toBeNull();
    expect(r.daily.some((b) => b.day === '2026-05-30')).toBe(true);
  });

  it('ignores Claude Code <synthetic> placeholder lines (no phantom model row, no false unknown-model flag)', async () => {
    const d = join(root, 'C--g-syn');
    mkdirSync(d, { recursive: true });
    // Claude Code tags API-error / interrupt placeholders as model "<synthetic>" with an all-zero usage block.
    writeFileSync(join(d, 's.jsonl'), [
      asst('claude-opus-4-8', { input_tokens: 100, output_tokens: 50 }),
      asst('<synthetic>', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    ].join('\n'));
    const r = await scanUsage([{ path: 'C:\\g\\syn', name: 'syn' }], root, Infinity);
    expect(r.byModel.find((m) => m.model === '<synthetic>')).toBeUndefined();    // no phantom "<synthetic>" model
    expect(r.hasUnknownModel).toBe(false);                                        // synthetic must NOT trip the unknown-model warning
    expect(r.byProject[0].hasUnknownModel).toBe(false);
    expect(r.byModel.find((m) => m.model === 'claude-opus-4-8')).toBeTruthy();    // the real model is still reported
    expect(r.global.input).toBe(100);                                             // real totals unaffected (synthetic = 0 tokens)
    expect(r.globalCost).toBeCloseTo((100 * 5 + 50 * 25) / 1_000_000, 6);         // cost still computed, no false "*"
  });

  it('returns zeros for a project with no session dir', async () => {
    const r = await scanUsage([{ path: 'C:\\g\\missing', name: 'missing' }], root, Infinity);
    expect(r.global.input).toBe(0);
    expect(r.byProject[0].sessions).toBe(0);
  });

  it('passes status through to byProject (default active; deleted tagged) and totals include deleted', async () => {
    const d = join(root, 'C--g-del');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's.jsonl'), asst('claude-opus-4-8', { input_tokens: 10 }));
    const r = await scanUsage([
      { path: 'C:\\g\\proj', name: 'proj' },                       // no status → active
      { path: 'C:\\g\\del', name: 'del', status: 'deleted' },     // a deleted project still has ~/.claude usage
    ], root, Infinity);
    expect(r.byProject.find((p) => p.name === 'proj')!.status).toBe('active');
    expect(r.byProject.find((p) => p.name === 'del')!.status).toBe('deleted');
    expect(r.global.input).toBe(10); // deleted project's tokens included in the honest total
  });

  it('caches a small session file (memory-bounded perf cache still works for the common case)', async () => {
    const d = join(root, 'C--g-small');
    mkdirSync(d, { recursive: true });
    const f = join(d, 's.jsonl');
    writeFileSync(f, asst('claude-opus-4-8', { input_tokens: 1 }));
    await scanUsage([{ path: 'C:\\g\\small', name: 'small' }], root, Infinity);
    expect(_cacheHasFile(f)).toBe(true);
  });

  it('does NOT cache a session file over MAX_CACHED_FILE_BYTES — a huge transcript must never be held in memory forever', async () => {
    // Real-world trigger: a multi-hundred-MB Claude session file, held forever in a module-level Map,
    // ballooned the main process to multiple GB within ~1 minute of a cold start (the eager,
    // unfiltered projectsView.ts per-project cost fill calls usage:report(0) = every file, all time)
    // and crashed it with no catchable exception. Oversized files must be processed but NOT retained.
    const d = join(root, 'C--g-huge');
    mkdirSync(d, { recursive: true });
    const f = join(d, 's.jsonl');
    const line = asst('claude-opus-4-8', { input_tokens: 1 });
    const pad = 'x'.repeat(MAX_CACHED_FILE_BYTES); // one line alone already exceeds the cap
    writeFileSync(f, line + '\n// ' + pad);
    const r = await scanUsage([{ path: 'C:\\g\\huge', name: 'huge' }], root, Infinity);
    expect(_cacheHasFile(f)).toBe(false);
    expect(r.global.input).toBe(1); // still processed correctly even though not cached
  });

  it('bounds the TOTAL cached bytes — the least-recently-used file is evicted when the budget overflows', async () => {
    // The per-file 5MB cap alone still allows unbounded growth: thousands of just-under-cap
    // sessions can add up to multiple GB across the life of this long-lived process.
    const mk = (proj: string): string => {
      const d = join(root, `C--g-${proj}`);
      mkdirSync(d, { recursive: true });
      const f = join(d, 's.jsonl');
      writeFileSync(f, asst('claude-opus-4-8', { input_tokens: 1 }) + '\n// ' + 'x'.repeat(2 * 1024));
      return f;
    };
    _setCacheBudget(5 * 1024); // room for two ~2KB files, not three
    const [fa, fb, fc] = [mk('lru-a'), mk('lru-b'), mk('lru-c')];
    await scanUsage([{ path: 'C:\\g\\lru-a', name: 'a' }], root, Infinity);
    await scanUsage([{ path: 'C:\\g\\lru-b', name: 'b' }], root, Infinity);
    await scanUsage([{ path: 'C:\\g\\lru-c', name: 'c' }], root, Infinity);
    expect(_cacheHasFile(fa)).toBe(false); // oldest evicted
    expect(_cacheHasFile(fb)).toBe(true);
    expect(_cacheHasFile(fc)).toBe(true);
  });

  it('a cache hit refreshes recency — true LRU, not insertion-order FIFO', async () => {
    const mk = (proj: string): string => {
      const d = join(root, `C--g-${proj}`);
      mkdirSync(d, { recursive: true });
      const f = join(d, 's.jsonl');
      writeFileSync(f, asst('claude-opus-4-8', { input_tokens: 1 }) + '\n// ' + 'x'.repeat(2 * 1024));
      return f;
    };
    _setCacheBudget(5 * 1024);
    const [fa, fb, fc] = [mk('fifo-a'), mk('fifo-b'), mk('fifo-c')];
    await scanUsage([{ path: 'C:\\g\\fifo-a', name: 'a' }], root, Infinity);
    await scanUsage([{ path: 'C:\\g\\fifo-b', name: 'b' }], root, Infinity);
    await scanUsage([{ path: 'C:\\g\\fifo-a', name: 'a' }], root, Infinity); // hit → a is now most-recent
    await scanUsage([{ path: 'C:\\g\\fifo-c', name: 'c' }], root, Infinity); // overflow → evict b, NOT a
    expect(_cacheHasFile(fa)).toBe(true);
    expect(_cacheHasFile(fb)).toBe(false);
    expect(_cacheHasFile(fc)).toBe(true);
  });

  it('yields to the event loop instead of blocking it for the whole scan', async () => {
    // usage:report(0) runs on EVERY deck load; a fully-synchronous scan freezes all IPC and live
    // cockpit PTY output for its whole duration (2.5GB of session files in the real dataset).
    // The scan must cross a real event-loop turn so other work can interleave.
    const d = join(root, 'C--g-async');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's.jsonl'), asst('claude-opus-4-8', { input_tokens: 1 }));
    const order: string[] = [];
    setImmediate(() => order.push('loop-turn'));
    await scanUsage([{ path: 'C:\\g\\async', name: 'async' }], root, Infinity);
    order.push('scan-done');
    expect(order).toEqual(['loop-turn', 'scan-done']);
  });

  it('sums active time from message gaps, capping idle stretches', async () => {
    const d = join(root, 'C--g-time');
    mkdirSync(d, { recursive: true });
    // 0m → 3m (active 3m) → 120m idle (skipped) → 121m (active 1m). Total active = 4m.
    writeFileSync(join(d, 's.jsonl'), [
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T10:00:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T10:03:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T12:00:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T12:01:00.000Z'),
    ].join('\n'));
    const r = await scanUsage([{ path: 'C:\\g\\time', name: 'time' }], root, Infinity);
    expect(r.activeMs).toBe(4 * 60_000);
    expect(r.byProject[0].activeMs).toBe(4 * 60_000);
  });
});
