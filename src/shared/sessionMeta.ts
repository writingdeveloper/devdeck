import { activeMsFromTimestamps, SYNTHETIC_MODEL } from './usage';

/** Map a raw model id to a short friendly name: claude-opus-4-8 → "Opus 4.8", bare "sonnet" → "Sonnet".
 *  Returns null for synthetic/empty (so callers can hide it). Unknown ids pass through unchanged. */
export function friendlyModel(raw: string | null | undefined): string | null {
  if (!raw || raw === SYNTHETIC_MODEL) return null;
  const m = raw.toLowerCase().match(/(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d+))?/);
  if (!m) return raw;
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[2] && m[3] ? ` ${m[2]}.${m[3]}` : m[2] ? ` ${m[2]}` : '';
  return fam + ver;
}

/** Current-context % = context tokens / window, rounded and clamped to 100. null when there's
 *  nothing meaningful to show (no tokens, or an unknown/zero window). */
export function contextPercent(tokens: number, windowTokens: number): number | null {
  if (!(tokens > 0) || !(windowTokens > 0)) return null;
  return Math.min(100, Math.round((tokens / windowTokens) * 100));
}

/** Compact-danger tint for a context %: ≥95 crit (compact imminent), ≥80 warn, else ok. */
export function contextSeverity(pct: number): 'ok' | 'warn' | 'crit' {
  return pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : 'ok';
}

function num(x: unknown): number { return typeof x === 'number' && Number.isFinite(x) ? x : 0; }

/**
 * Parse a Claude session .jsonl into { model, activeMs, contextTokens }:
 * - model = the last MAIN-chain (non-sidechain) assistant model, ignoring "<synthetic>" (raw id).
 * - activeMs = focused working time from the message timestamps (5-min idle-capped, shared usage logic).
 * - contextTokens = the LAST main-chain assistant turn's input+cache_read+cache_creation usage — the
 *   size of the context sent on the most recent turn (matches Claude Code's own "Context %" numerator).
 * Pure (takes the raw file text) so it's unit-testable without the filesystem.
 */
export function parseSessionMeta(raw: string): { model: string | null; activeMs: number; contextTokens: number } {
  const timestamps: number[] = [];
  let model: string | null = null;
  let contextTokens = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: { timestamp?: unknown; isSidechain?: unknown; message?: { model?: unknown; usage?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) timestamps.push(ts);
    if (o.isSidechain) continue; // subagent turns aren't the main conversation's model or context
    const mdl = o.message?.model;
    if (typeof mdl === 'string' && mdl !== SYNTHETIC_MODEL) model = mdl;
    const u = o.message?.usage as { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | undefined;
    if (u && typeof u === 'object') {
      const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      if (ctx > 0) contextTokens = ctx; // last non-zero turn = the current context size
    }
  }
  return { model, activeMs: activeMsFromTimestamps(timestamps), contextTokens };
}
