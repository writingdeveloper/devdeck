/** A cockpit session remembered across restarts, enough to re-open it via the agent's resume command. */
export interface PersistedSession {
  projectPath: string;
  name: string;
  sessionId: string | null; // the specific session to resume, or null to continue/new
  agentId: string;          // 'claude' | 'codex' — which agent the session was opened with
  label?: string | null;    // user-given custom name (overrides the auto label); null/absent = auto
}

const MAX_PERSISTED = 50;
const MAX_LABEL = 60;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Validate/normalize a persisted-session list loaded from disk (defends against a corrupted
 * state.json): drops entries without a string projectPath, defaults the name to the path
 * basename, coerces sessionId to string|null and agentId to 'claude'/'codex', caps the count.
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
      agentId: o.agentId === 'codex' ? 'codex' : 'claude',
      label,
    });
    if (out.length >= MAX_PERSISTED) break;
  }
  return out;
}
