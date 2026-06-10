export interface UsageTotals { input: number; output: number; cacheWrite: number; cacheRead: number; }

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Price per MILLION tokens (USD). cacheWrite ≈ 1.25× input (5m), cacheRead ≈ 0.1× input. */
export interface PriceCard { input: number; output: number; cacheWrite: number; cacheRead: number; }

// Approximate published Anthropic prices ($/MTok). EDIT when prices change — cost is an ESTIMATE.
export const MODEL_PRICING: Record<string, PriceCard> = {
  'claude-opus-4-8': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

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
