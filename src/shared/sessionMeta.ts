import { activeMsFromTimestamps } from './usage';

/** Map a raw model id to a short friendly name: claude-opus-4-8 → "Opus 4.8", bare "sonnet" → "Sonnet".
 *  Returns null for synthetic/empty (so callers can hide it). Unknown ids pass through unchanged. */
export function friendlyModel(raw: string | null | undefined): string | null {
  if (!raw || raw === '<synthetic>') return null;
  const m = raw.toLowerCase().match(/(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d+))?/);
  if (!m) return raw;
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[2] && m[3] ? ` ${m[2]}.${m[3]}` : m[2] ? ` ${m[2]}` : '';
  return fam + ver;
}

/**
 * Parse a Claude session .jsonl into { model, activeMs }:
 * - model = the last MAIN-chain (non-sidechain) assistant model, ignoring "<synthetic>" (raw id).
 * - activeMs = focused working time from the message timestamps (5-min idle-capped, shared usage logic).
 * Pure (takes the raw file text) so it's unit-testable without the filesystem.
 */
export function parseSessionMeta(raw: string): { model: string | null; activeMs: number } {
  const timestamps: number[] = [];
  let model: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: { timestamp?: unknown; isSidechain?: unknown; message?: { model?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) timestamps.push(ts);
    const mdl = o.message?.model;
    if (!o.isSidechain && typeof mdl === 'string' && mdl !== '<synthetic>') model = mdl;
  }
  return { model, activeMs: activeMsFromTimestamps(timestamps) };
}
