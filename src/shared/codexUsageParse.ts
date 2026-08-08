import { normalizeCodexTotals, type CodexRawUsage, type UsageTotals } from './usage';

type JsonRecord = Record<string, unknown>;

export interface CodexUsageCounters {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}

export interface CodexUsageCursor {
  model: string | null;
  cumulative: CodexUsageCounters | null;
  seenFallbackKeys: string[];
}

export interface CodexUsageEntry {
  day: string;
  dayMs: number;
  timestampMs: number;
  model: string;
  totals: UsageTotals;
}

export interface CodexUsageLineResult {
  cursor: CodexUsageCursor;
  entry: CodexUsageEntry | null;
  activityTimestampMs: number | null;
}

export function initialCodexUsageCursor(): CodexUsageCursor {
  return { model: null, cumulative: null, seenFallbackKeys: [] };
}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function counter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function counters(value: unknown): CodexUsageCounters | null {
  if (!record(value)) return null;
  const out = {
    input_tokens: counter(value.input_tokens ?? value.inputTokens),
    cached_input_tokens: counter(value.cached_input_tokens ?? value.cachedInputTokens),
    cache_write_input_tokens: counter(value.cache_write_input_tokens ?? value.cacheWriteInputTokens),
    output_tokens: counter(value.output_tokens ?? value.outputTokens),
  };
  return Object.values(out).some((n) => n > 0) ? out : null;
}

function subtract(current: CodexUsageCounters, previous: CodexUsageCounters): CodexUsageCounters | null {
  const keys = Object.keys(current) as Array<keyof CodexUsageCounters>;
  if (keys.some((key) => current[key] < previous[key])) return null;
  return {
    input_tokens: current.input_tokens - previous.input_tokens,
    cached_input_tokens: current.cached_input_tokens - previous.cached_input_tokens,
    cache_write_input_tokens: current.cache_write_input_tokens - previous.cache_write_input_tokens,
    output_tokens: current.output_tokens - previous.output_tokens,
  };
}

function hasTokens(value: CodexUsageCounters | null): value is CodexUsageCounters {
  return !!value && Object.values(value).some((n) => n > 0);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDay(timestampMs: number): { day: string; dayMs: number } {
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  return { day, dayMs: Date.parse(`${day}T00:00:00.000Z`) };
}

function activityRecord(type: unknown, payload: JsonRecord | null): boolean {
  if (type === 'response_item') return payload?.type === 'message';
  if (type !== 'event_msg' || !payload) return false;
  return ['user_message', 'agent_message', 'task_complete', 'token_count'].includes(String(payload.type));
}

export function parseCodexUsageLine(line: string, cursor: CodexUsageCursor): CodexUsageLineResult {
  let root: JsonRecord;
  try {
    const value: unknown = JSON.parse(line);
    if (!record(value)) return { cursor, entry: null, activityTimestampMs: null };
    root = value;
  } catch {
    return { cursor, entry: null, activityTimestampMs: null };
  }

  const payload = record(root.payload) ? root.payload : null;
  const timestampMs = timestamp(root.timestamp);
  const activityTimestampMs = timestampMs != null && activityRecord(root.type, payload) ? timestampMs : null;

  if (root.type === 'turn_context' && payload) {
    const rawModel = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (!rawModel || rawModel.length > 120) return { cursor, entry: null, activityTimestampMs };
    return { cursor: { ...cursor, model: rawModel }, entry: null, activityTimestampMs };
  }

  if (root.type !== 'event_msg' || payload?.type !== 'token_count' || !record(payload.info) || timestampMs == null) {
    return { cursor, entry: null, activityTimestampMs };
  }

  const total = counters(payload.info.total_token_usage ?? payload.info.totalTokenUsage);
  const last = counters(payload.info.last_token_usage ?? payload.info.lastTokenUsage);
  let delta: CodexUsageCounters | null = null;
  let nextCursor = cursor;

  if (total) {
    delta = cursor.cumulative ? subtract(total, cursor.cumulative) : total;
    if (!delta && cursor.cumulative) delta = last;
    nextCursor = { ...cursor, cumulative: total };
  } else if (last) {
    const key = `${timestampMs}|${cursor.model ?? ''}|${last.input_tokens}|${last.cached_input_tokens}|${last.cache_write_input_tokens}|${last.output_tokens}`;
    if (!cursor.seenFallbackKeys.includes(key)) {
      delta = last;
      nextCursor = { ...cursor, seenFallbackKeys: [...cursor.seenFallbackKeys.slice(-127), key] };
    }
  }

  if (!hasTokens(delta)) return { cursor: nextCursor, entry: null, activityTimestampMs };
  const totals = normalizeCodexTotals(delta as CodexRawUsage);
  const { day, dayMs } = utcDay(timestampMs);
  return {
    cursor: nextCursor,
    entry: { day, dayMs, timestampMs, model: cursor.model ?? '<unknown>', totals },
    activityTimestampMs,
  };
}
