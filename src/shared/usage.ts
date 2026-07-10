export interface UsageTotals { input: number; output: number; cacheWrite: number; cacheRead: number; }

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Claude Code's sentinel model id for assistant lines it generated WITHOUT a real model call —
 * API-error placeholders (e.g. a 401 during a token-refresh gap), interrupts, injected notices.
 * They carry an all-zero usage block, so they are not real usage and must be excluded from the
 * per-model breakdown and the unknown-model flag (the cockpit's session meta already skips them).
 */
export const SYNTHETIC_MODEL = '<synthetic>';

/** Price per MILLION tokens (USD). cacheWrite ≈ 1.25× input (5m), cacheRead ≈ 0.1× input. */
export interface PriceCard { input: number; output: number; cacheWrite: number; cacheRead: number; }

// Approximate published Anthropic prices ($/MTok). EDIT when prices change — cost is an ESTIMATE.
// Opus dropped from $15/$75 to $5/$25 starting at 4.6 (1M context at standard pricing, no long-context
// premium). The old $15/$75 card on 4.8 3x-inflated every Opus 4.8 cost estimate. Opus 4.1 keeps the
// legacy $15/$75. cacheWrite ~= 1.25x input (5m), cacheRead ~= 0.1x input.
export const MODEL_PRICING: Record<string, PriceCard> = {
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  // Introductory pricing; priceFor() auto-switches to the standard Sonnet-tier rate
  // (SONNET5_STANDARD) from 2026-09-01 — no manual edit needed (see SONNET5_ROLLOFF_MS).
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

// Sonnet-5 launched at an introductory rate; it rolls off to the standard Sonnet-tier rate on this
// date (UTC). priceFor() is date-aware so the estimate self-corrects at the rollover instead of
// silently under-reporting ~33% until someone remembers to edit the card (guarded by a test).
export const SONNET5_ROLLOFF_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00Z (month is 0-based: 8 = Sept)
const SONNET5_STANDARD: PriceCard = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

// Bare family name (no version) → newest card for that family. Module-scope single definition.
const BARE_FAMILY_ALIAS: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};

/**
 * Resolve a raw model id string to its price card, tolerating the two id shapes real transcripts
 * carry beyond the exact MODEL_PRICING keys above:
 *  (a) exact key match;
 *  (b) a trailing -YYYYMMDD date suffix (e.g. claude-haiku-4-5-20251001) — strip it and retry;
 *  (c) a bare family name with no version at all (e.g. "sonnet") — these show up rarely (manual
 *      config, older tooling) and are inherently version-ambiguous, so map to the NEWEST card for
 *      that family as the best available estimate, not a guarantee of the exact model that ran.
 * Non-Claude ids (ltx-*, hunyuan3d-*, etc.) fall through to undefined — stay unknown, as they should.
 */
export function priceFor(model: string, now: number = Date.now()): PriceCard | undefined {
  let key: string | undefined;
  if (MODEL_PRICING[model]) key = model;
  else {
    const stripped = model.replace(/-\d{8}$/, '');
    key = stripped !== model && MODEL_PRICING[stripped] ? stripped : BARE_FAMILY_ALIAS[model];
  }
  if (!key) return undefined;
  // Sonnet-5's introductory price rolls off to the standard Sonnet-tier rate on 2026-09-01 (UTC).
  if (key === 'claude-sonnet-5' && now >= SONNET5_ROLLOFF_MS) return SONNET5_STANDARD;
  return MODEL_PRICING[key];
}

/**
 * Gap between two consecutive session messages longer than this counts as idle
 * (overnight, stepped away) and is excluded from "active" time. Keeps the summed
 * working time meaningful instead of the full first→last span the terminal ⏱️ shows.
 */
export const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

/** Sum of consecutive-timestamp gaps that are within the idle cap. Input may be unsorted. */
export function activeMsFromTimestamps(timestampsMs: number[]): number {
  if (timestampsMs.length < 2) return 0;
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap <= ACTIVE_GAP_CAP_MS) active += gap;
  }
  return active;
}

/** Human-friendly duration: "14h 9m", "45m", "0m". Floors to whole minutes. */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function emptyTotals(): UsageTotals { return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }; }

/** Sum two already-aggregated totals (digest rollups combining into report totals). */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}

export function addUsage(t: UsageTotals, u: RawUsage): UsageTotals {
  return {
    input: t.input + (u.input_tokens ?? 0),
    output: t.output + (u.output_tokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
  };
}

/** Estimated USD cost, or null when the model price card is unknown. */
export function estimateCost(t: UsageTotals, price: PriceCard | undefined): number | null {
  if (!price) return null;
  const M = 1_000_000;
  return (t.input * price.input + t.output * price.output + t.cacheWrite * price.cacheWrite + t.cacheRead * price.cacheRead) / M;
}
