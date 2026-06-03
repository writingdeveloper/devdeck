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
