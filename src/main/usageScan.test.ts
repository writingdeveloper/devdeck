import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanUsage } from './usageScan';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-usage-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function asst(model: string, u: Record<string, number>, ts = '2026-06-01T10:00:00.000Z') {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage: u } });
}

describe('scanUsage', () => {
  it('aggregates per-project, per-model, and global totals with cost', () => {
    const d = join(root, 'C--g-proj');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's1.jsonl'), [
      asst('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      asst('claude-opus-4-8', { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n'));

    const r = scanUsage([{ path: 'C:\\g\\proj', name: 'proj' }], root, Infinity);
    expect(r.global.input).toBe(1_000_000);
    expect(r.global.output).toBe(1_000_000);
    expect(r.byProject[0].name).toBe('proj');
    expect(r.byProject[0].sessions).toBe(1);
    expect(r.globalCost).toBeCloseTo(15 + 75, 3);
    expect(r.byProject[0].costEstimate).toBeCloseTo(15 + 75, 3);
    expect(r.byModel.find((m) => m.model === 'claude-opus-4-8')).toBeTruthy();
  });

  it('flags unknown models (tokens counted, no cost) and bins daily', () => {
    const d = join(root, 'C--g-x');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 's.jsonl'), asst('mystery-model', { input_tokens: 5 }, '2026-05-30T00:00:00.000Z'));
    const r = scanUsage([{ path: 'C:\\g\\x', name: 'x' }], root, Infinity);
    expect(r.hasUnknownModel).toBe(true);
    expect(r.global.input).toBe(5);
    expect(r.byProject[0].costEstimate).toBeNull();
    expect(r.daily.some((b) => b.day === '2026-05-30')).toBe(true);
  });

  it('returns zeros for a project with no session dir', () => {
    const r = scanUsage([{ path: 'C:\\g\\missing', name: 'missing' }], root, Infinity);
    expect(r.global.input).toBe(0);
    expect(r.byProject[0].sessions).toBe(0);
  });

  it('sums active time from message gaps, capping idle stretches', () => {
    const d = join(root, 'C--g-time');
    mkdirSync(d, { recursive: true });
    // 0m → 3m (active 3m) → 120m idle (skipped) → 121m (active 1m). Total active = 4m.
    writeFileSync(join(d, 's.jsonl'), [
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T10:00:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T10:03:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T12:00:00.000Z'),
      asst('claude-opus-4-8', { input_tokens: 1 }, '2026-06-01T12:01:00.000Z'),
    ].join('\n'));
    const r = scanUsage([{ path: 'C:\\g\\time', name: 'time' }], root, Infinity);
    expect(r.activeMs).toBe(4 * 60_000);
    expect(r.byProject[0].activeMs).toBe(4 * 60_000);
  });
});
