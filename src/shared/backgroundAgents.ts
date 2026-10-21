// src/shared/backgroundAgents.ts
// Claude Code's own background sessions (`claude --bg`, the agent view), as `claude agents --json`
// reports them. DevDeck never started these, so until now it never showed them — and the ones
// waiting on the person ("blocked") sat there unseen.

export type BackgroundState = 'running' | 'working' | 'blocked' | 'idle' | 'failed';

export interface BackgroundAgent {
  /** The short id `claude attach` takes. */
  id: string;
  /** The conversation it is running. */
  sessionId: string;
  cwd: string;
  name: string | null;
  state: BackgroundState;
  startedAt: number | null;
}

const SHORT_ID_RE = /^[0-9a-f]{6,16}$/i;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** States worth showing; done/completed/stopped sessions are history. */
const SHOWN = new Set<BackgroundState>(['running', 'working', 'blocked', 'idle', 'failed']);
/** A failed session stays listed this long, then is old news. */
export const FAILED_SHOWN_MS = 7 * 24 * 3_600_000;
const MAX_LISTED = 50;

/** `claude agents --json --all` → the background sessions worth showing, newest first. */
export function parseBackgroundAgents(json: string, nowMs: number): BackgroundAgent[] {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: BackgroundAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (r.kind !== 'background') continue;
    const id = typeof r.id === 'string' ? r.id : '';
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
    const cwd = typeof r.cwd === 'string' ? r.cwd : '';
    const state = r.state as BackgroundState;
    if (!SHORT_ID_RE.test(id) || !SESSION_ID_RE.test(sessionId) || !cwd || !SHOWN.has(state)) continue;
    const startedAt = typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : null;
    if (state === 'failed' && (startedAt === null || nowMs - startedAt > FAILED_SHOWN_MS)) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 200) : null;
    out.push({ id, sessionId, cwd, name, state, startedAt });
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, MAX_LISTED);
}

/** The short ids `claude attach` accepts — the only thing ever put on its command line. */
export function isBackgroundAgentId(id: unknown): id is string {
  return typeof id === 'string' && SHORT_ID_RE.test(id);
}
