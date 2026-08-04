import { activeMsFromTimestamps, SYNTHETIC_MODEL } from './usage';
import { textOf, isWrapper } from './sessionParse';

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

/** Retained-text cap: a turn can be megabytes, and only the opening sentence ever reaches the row. */
const TEXT_CAP = 400;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Ring cap for one turn's edits — a long turn can touch hundreds of files; the row shows the newest few. */
const EDITS_CAP = 64;
const EDITED_SHOWN = 4;

/** Last path segment, without importing node:path (this module is bundled into the renderer too). */
function baseName(p: string): string {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

export interface ParsedSessionMeta {
  model: string | null;
  activeMs: number;
  contextTokens: number;
  /** Last main-chain assistant text (capped) — the headline source for the sidebar summary. */
  assistantText: string | null;
  /** Files edited since the last genuine user message, newest first (deduped, few). */
  editedFiles: string[];
  /** Last genuine user message (capped) — weakest summary source, but always present. */
  userText: string | null;
}

/**
 * Parse a Claude session .jsonl into { model, activeMs, contextTokens } plus the summary sources:
 * - model = the last MAIN-chain (non-sidechain) assistant model, ignoring "<synthetic>" (raw id).
 * - activeMs = focused working time from the message timestamps (5-min idle-capped, shared usage logic).
 * - contextTokens = the LAST main-chain assistant turn's input+cache_read+cache_creation usage — the
 *   size of the context sent on the most recent turn (matches Claude Code's own "Context %" numerator).
 * - assistantText / editedFiles / userText = what the sidebar's summary line is picked from. They ride
 *   along in this same pass (the file is already being read for the fields above), so the summary
 *   costs no extra disk I/O. editedFiles resets on each genuine user message so it describes the
 *   CURRENT turn, not everything the session ever touched.
 * Pure (takes the raw file text) so it's unit-testable without the filesystem.
 */
export function parseSessionMeta(raw: string): ParsedSessionMeta {
  const timestamps: number[] = [];
  let model: string | null = null;
  let contextTokens = 0;
  let assistantText: string | null = null;
  let userText: string | null = null;
  let edited: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; message?: { model?: unknown; usage?: unknown; content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) timestamps.push(ts);
    if (o.isSidechain) continue; // subagent turns aren't the main conversation's model, context or work
    const mdl = o.message?.model;
    if (typeof mdl === 'string' && mdl !== SYNTHETIC_MODEL) model = mdl;
    const u = o.message?.usage as { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | undefined;
    if (u && typeof u === 'object') {
      const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      if (ctx > 0) contextTokens = ctx; // last non-zero turn = the current context size
    }
    if (!o.message) continue;
    if (o.type === 'user') {
      const t = textOf(o.message.content).trim();
      if (!t || isWrapper(t)) continue; // tool results / harness scaffolding aren't a new prompt
      userText = t.slice(0, TEXT_CAP);
      edited = []; // a fresh ask — what the previous turn edited no longer describes the work
      continue;
    }
    if (o.type !== 'assistant') continue;
    const t = textOf(o.message.content).trim();
    if (t) assistantText = t.slice(0, TEXT_CAP);
    const blocks = o.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const blk = b as { type?: unknown; name?: unknown; input?: { file_path?: unknown } };
      if (blk.type !== 'tool_use' || typeof blk.name !== 'string' || !EDIT_TOOLS.has(blk.name)) continue;
      const fp = blk.input?.file_path;
      if (typeof fp !== 'string' || !fp) continue;
      edited.push(baseName(fp));
      if (edited.length > EDITS_CAP) edited.shift();
    }
  }
  // Newest first, deduped (the same file is usually edited many times in one turn).
  const editedFiles: string[] = [];
  for (let i = edited.length - 1; i >= 0 && editedFiles.length < EDITED_SHOWN; i--) {
    if (!editedFiles.includes(edited[i])) editedFiles.push(edited[i]);
  }
  return { model, activeMs: activeMsFromTimestamps(timestamps), contextTokens, assistantText, editedFiles, userText };
}
