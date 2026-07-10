import { basename } from './paths';

/** A cockpit session remembered across restarts, enough to re-open it via the agent's resume command. */
export interface PersistedSession {
  projectPath: string;
  name: string;
  sessionId: string | null; // the specific session to resume, or null to continue/new
  agentId: string;          // 'claude' | 'antigravity' — which agent the session was opened with
  label?: string | null;    // user-given custom name (overrides the auto label); null/absent = auto
  pinned?: boolean;         // user pinned this session to the top group (absent = not pinned)
}

const MAX_PERSISTED = 50;
const MAX_LABEL = 60;

/**
 * Choose which session a restored cockpit tile should actually resume. Claude Code appends in place
 * (--resume/-c/compaction never fork), so a frozen open-time id goes stale the moment a newer
 * conversation exists for the project — restoring it lands the user in the PAST. Instead resume the
 * NEWEST session (`newestFirstIds` is mtime-desc from listSessions) that isn't already open in another
 * tile, so a stale pin self-heals and multiple tiles of one project each get a distinct recent
 * conversation. null → nothing to resume (caller falls back to continue/new).
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
 * basename, coerces sessionId to string|null and agentId to 'claude'/'antigravity', caps the count.
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
      agentId: o.agentId === 'antigravity' ? 'antigravity' : 'claude',
      label,
      pinned: o.pinned === true ? true : undefined, // omit when not pinned (keeps state.json minimal)
    });
    if (out.length >= MAX_PERSISTED) break;
  }
  return out;
}
