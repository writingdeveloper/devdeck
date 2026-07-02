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

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

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
