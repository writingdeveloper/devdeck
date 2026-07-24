import { basename } from './paths';

/** A cockpit session remembered across restarts, enough to re-open it via the agent's resume command. */
export interface PersistedSession {
  projectPath: string;
  name: string;
  sessionId: string | null; // the specific session to resume, or null to continue/new
  agentId: string;          // 'claude' | 'antigravity' | 'codex' — which agent the session was opened with
  label?: string | null;    // user-given custom name (overrides the auto label); null/absent = auto
  pinned?: boolean;         // user pinned this session to the top group (absent = not pinned)
}

const MAX_PERSISTED = 50;
const MAX_LABEL = 60;

/**
 * Choose which session a restored cockpit tile should actually resume. Claude Code appends in place
 * for --resume/-c/compaction, but /clear DOES start a brand-new session id in the same terminal —
 * live tiles track that via pickDriftedSessionId below, so the persisted id stays current. This
 * fallback resumes the NEWEST session (`newestFirstIds` is mtime-desc from listSessions) that isn't
 * already open in another tile, so a stale pin self-heals and multiple tiles of one project each get
 * a distinct recent conversation. null → nothing to resume (caller falls back to continue/new).
 */
export function pickRestoreSessionId(newestFirstIds: string[], liveIds: Set<string>): string | null {
  for (const id of newestFirstIds) if (!liveIds.has(id)) return id;
  return null;
}

/**
 * Which conversation a restored tile should reopen. Prefer the tile's OWN saved id when that
 * conversation still exists on disk and isn't already open in another tile — so a project's several
 * distinct conversations each keep their own tile instead of every tile collapsing onto the newest
 * one or two (the "3rd session vanished" bug). Only fall back to the newest not-live session when the
 * saved id was deleted or is already live. `newestFirstIds` must be ALL of the project's on-disk ids
 * (mtime-desc) so an older-but-valid saved id is still recognized as existing.
 */
export function resolveRestoreSessionId(savedId: string | null, newestFirstIds: string[], liveIds: Set<string>): string | null {
  if (savedId && newestFirstIds.includes(savedId) && !liveIds.has(savedId)) return savedId;
  return pickRestoreSessionId(newestFirstIds, liveIds);
}

/** One on-disk session file's identity + timestamps, for the live drift detector below. */
export interface SessionFileStat { id: string; mtimeMs: number; birthtimeMs: number; }

// A candidate file only counts as "this tile's output" when its mtime tracks the tile's last PTY
// output this closely — an unrelated session streaming in another terminal won't stay coupled.
const DRIFT_COUPLING_MS = 8_000;

/**
 * Detect that a live tile's conversation MOVED to a different on-disk session. `--resume`/`-c`/
 * compaction append in place, but /clear (and a manual `claude` run inside the tile's shell) starts a
 * BRAND-NEW session id in the same terminal — the tile's open-time id then goes permanently stale, so
 * persisting it restores the PAST conversation after a restart/update (the "과거 데이터 복원" bug).
 *
 * Adopt a new id only on unambiguous evidence, ALL of:
 *  - the tile produced output since the last check (something was written on our behalf),
 *  - the tile's CURRENT file did not move since the last check (the output went elsewhere),
 *  - exactly ONE unclaimed file moved since the last check, was born after the tile opened,
 *    and its mtime tracks the tile's output time (uncoupled writes belong to other terminals).
 * Anything ambiguous returns null (keep the current id — a later sample disambiguates).
 */
export function pickDriftedSessionId(
  stats: SessionFileStat[],
  opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number },
): string | null {
  if (opts.lastDataAtMs <= opts.sinceMs) return null; // no output since the last check
  const cur = stats.find((s) => s.id === opts.currentId);
  if (cur && cur.mtimeMs > opts.sinceMs) return null; // our own file is still being written — no drift
  const claimed = new Set(opts.claimedIds);
  const candidates = stats.filter((s) =>
    s.id !== opts.currentId && !claimed.has(s.id)
    && s.mtimeMs > opts.sinceMs
    && s.birthtimeMs > opts.openedAtMs
    && Math.abs(s.mtimeMs - opts.lastDataAtMs) <= DRIFT_COUPLING_MS);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * A newly-opened session that lands on a conversation a saved (restorable) entry already points at
 * CONSUMES that entry — and must inherit its user-given pin + label unless the open request carries
 * its own. Without this, opening a project from the deck / task board / ⟳ restart (none of which
 * know about pins) silently erased the pin from persistence even though state.json had saved it.
 */
export function adoptRestorableMatch(
  restorable: PersistedSession[],
  sessionId: string | null,
  req: { label: string | null; pinned: boolean },
): { rest: PersistedSession[]; label: string | null; pinned: boolean } {
  if (!sessionId) return { rest: restorable, label: req.label, pinned: req.pinned };
  const match = restorable.find((r) => r.sessionId === sessionId);
  return {
    rest: restorable.filter((r) => r.sessionId !== sessionId),
    label: req.label ?? match?.label ?? null,
    pinned: req.pinned || match?.pinned === true,
  };
}

/**
 * Validate/normalize a persisted-session list loaded from disk (defends against a corrupted
 * state.json): drops entries without a string projectPath, defaults the name to the path
 * basename, coerces sessionId to string|null and agentId to a known provider, caps the count.
 */
export function sanitizePersistedList(raw: unknown): PersistedSession[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedSession[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.projectPath !== 'string' || !o.projectPath) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, MAX_LABEL) : null;
    out.push({
      projectPath: o.projectPath,
      name: typeof o.name === 'string' && o.name ? o.name : basename(o.projectPath),
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      agentId: o.agentId === 'antigravity' || o.agentId === 'codex' ? o.agentId : 'claude',
      label,
      pinned: o.pinned === true ? true : undefined, // omit when not pinned (keeps state.json minimal)
    });
    if (out.length >= MAX_PERSISTED) break;
  }
  return out;
}
