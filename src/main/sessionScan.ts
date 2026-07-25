// src/main/sessionScan.ts
// Cross-provider session lookup for the DECK. Every installed agent is asked about a project, and each
// session keeps its owning provider — so a card shows the provider that actually wrote the conversation
// and "open" launches that agent, instead of both being derived from the global agent selection.
//
// Cost: Claude's store is already keyed by project directory (cheap per project), but Codex and
// Antigravity keep flat stores that must be filtered by a recorded cwd. Scanning those per project
// would re-read the whole store once per project (100 projects → 100 passes), so they are indexed ONCE
// per deck refresh and looked up by canonical cwd key.
import type { AgentId, ProjectSession, SessionMeta } from '../shared/types';
import { cwdKey } from '../shared/paths';

/** Newest-first across providers, capped — ties broken by provider order so the result is stable. */
export function mergeProjectSessions(byProvider: { agentId: AgentId; sessions: SessionMeta[] }[], limit: number): ProjectSession[] {
  const all: ProjectSession[] = [];
  for (const { agentId, sessions } of byProvider) for (const s of sessions) all.push({ ...s, agentId });
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(0, limit));
}

/** Providers that have sessions here, ordered by their newest session (owner of `sessions[0]` first). */
export function providerOrderFromSessions(sessions: ProjectSession[]): AgentId[] {
  const out: AgentId[] = [];
  for (const s of sessions) if (!out.includes(s.agentId)) out.push(s.agentId);
  return out;
}

export interface SessionScanDeps {
  /** Installed providers, in display order. */
  installed: AgentId[];
  /** Per-project store (Claude): asked once per project. */
  perProject: Partial<Record<AgentId, (projectPath: string, limit: number) => Promise<SessionMeta[]>>>;
  /** Flat stores (Codex, Antigravity): indexed once, then looked up by canonical cwd key. */
  indexed: Partial<Record<AgentId, () => Map<string, SessionMeta[]>>>;
}

export interface ProjectSessionScan {
  /** Sessions for one project from EVERY installed provider, newest-first, each tagged with its owner. */
  sessions(projectPath: string, limit?: number): Promise<ProjectSession[]>;
}

/**
 * One scan per deck refresh: the flat-store indexes are built lazily on first use and reused for every
 * project of that refresh, then thrown away (so the next refresh sees fresh data — no TTL to tune).
 */
export function makeProjectSessionScan(deps: SessionScanDeps): ProjectSessionScan {
  const indexes = new Map<AgentId, Map<string, SessionMeta[]>>();
  const indexFor = (id: AgentId): Map<string, SessionMeta[]> => {
    let idx = indexes.get(id);
    if (!idx) {
      try { idx = deps.indexed[id]!(); } catch { idx = new Map(); } // an unreadable store must not blank the deck
      indexes.set(id, idx);
    }
    return idx;
  };
  return {
    async sessions(projectPath, limit = 5) {
      const key = cwdKey(projectPath);
      const byProvider: { agentId: AgentId; sessions: SessionMeta[] }[] = [];
      for (const agentId of deps.installed) {
        const perProject = deps.perProject[agentId];
        if (perProject) {
          try { byProvider.push({ agentId, sessions: await perProject(projectPath, limit) }); } catch { /* skip this provider */ }
        } else if (deps.indexed[agentId]) {
          byProvider.push({ agentId, sessions: indexFor(agentId).get(key) ?? [] });
        }
      }
      return mergeProjectSessions(byProvider, limit);
    },
  };
}
