import { describe, expect, it } from 'vitest';
import { initialCodexUsageCursor, parseCodexUsageLine, type CodexUsageCursor } from './codexUsageParse';

const line = (value: unknown): string => JSON.stringify(value);
const context = (model: string, timestamp = '2026-08-08T10:00:00.000Z'): string =>
  line({ type: 'turn_context', timestamp, payload: { model } });
const token = (total: Record<string, number> | null, last: Record<string, number>, timestamp: string): string =>
  line({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });

function parse(lines: string[], cursor: CodexUsageCursor = initialCodexUsageCursor()) {
  const entries = [];
  const activity: number[] = [];
  for (const raw of lines) {
    const result = parseCodexUsageLine(raw, cursor);
    cursor = result.cursor;
    if (result.entry) entries.push(result.entry);
    if (result.activityTimestampMs != null) activity.push(result.activityTimestampMs);
  }
  return { cursor, entries, activity };
}

describe('parseCodexUsageLine', () => {
  it('derives per-request usage from cumulative totals and follows model changes', () => {
    const first = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 7 };
    const second = { input_tokens: 130, cached_input_tokens: 70, cache_write_input_tokens: 10, output_tokens: 11 };
    const result = parse([
      context('gpt-5.6-sol'),
      token(first, first, '2026-08-08T10:01:00.000Z'),
      context('gpt-5.6-terra', '2026-08-08T10:02:00.000Z'),
      token(second, { input_tokens: 30, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 4 }, '2026-08-08T10:03:00.000Z'),
    ]);

    expect(result.entries.map((entry) => entry.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(result.entries[0].totals).toEqual({ input: 30, cacheRead: 60, cacheWrite: 10, output: 7 });
    expect(result.entries[1].totals).toEqual({ input: 20, cacheRead: 10, cacheWrite: 0, output: 4 });
    expect(result.entries[0]).toMatchObject({ day: '2026-08-08', dayMs: Date.UTC(2026, 7, 8) });
  });

  it('does not emit the same cumulative notification twice', () => {
    const usage = { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2 };
    const result = parse([context('gpt-5.6-sol'), token(usage, usage, '2026-08-08T10:01:00.000Z'), token(usage, usage, '2026-08-08T10:01:01.000Z')]);
    expect(result.entries).toHaveLength(1);
  });

  it('uses last-request usage when cumulative counters reset', () => {
    const result = parse([
      context('gpt-5.6-sol'),
      token({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 }, { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 }, '2026-08-08T10:01:00.000Z'),
      token({ input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 }, { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 }, '2026-08-08T10:02:00.000Z'),
    ]);
    expect(result.entries[1].totals).toEqual({ input: 15, cacheRead: 5, cacheWrite: 0, output: 2 });
  });

  it('accepts a last-only legacy event once', () => {
    const last = { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2 };
    const raw = token(null, last, '2026-08-08T10:01:00.000Z');
    const result = parse([context('gpt-5.5'), raw, raw]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].totals).toEqual({ input: 5, cacheRead: 4, cacheWrite: 0, output: 2 });
  });

  it('ignores malformed lines, invalid timestamps, and unusable counters', () => {
    const result = parse([
      '{',
      context('   '),
      token({ input_tokens: -1, output_tokens: Number.NaN }, { input_tokens: -1 }, 'not-a-date'),
    ]);
    expect(result.entries).toEqual([]);
    expect(result.activity).toEqual([]);
  });

  it('reports activity timestamps without retaining message text', () => {
    const result = parse([
      line({ type: 'event_msg', timestamp: '2026-08-08T10:00:00.000Z', payload: { type: 'user_message', message: 'private prompt' } }),
      line({ type: 'event_msg', timestamp: '2026-08-08T10:02:00.000Z', payload: { type: 'agent_message', message: 'private answer' } }),
    ]);
    expect(result.activity).toEqual([Date.parse('2026-08-08T10:00:00.000Z'), Date.parse('2026-08-08T10:02:00.000Z')]);
    expect(JSON.stringify(result.cursor)).not.toContain('private');
  });
});
