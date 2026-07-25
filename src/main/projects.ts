import type { GitInfo, ProjectViewModel, StoreEntry, ProjectSession, StaleThresholds, ResumeCue } from '../shared/types';
import type { RawProject } from './scanner';
import { classifyStaleness } from '../shared/staleness';
import { providerOrderFromSessions } from './sessionScan';

export interface BuildDeps {
  nowMs: number;
  thresholds: StaleThresholds;
  scan: () => Promise<RawProject[]>;
  git: (dir: string) => Promise<GitInfo>;
  /** Sessions from every installed provider, newest-first, each tagged with its owning agent. */
  sessions: (projectPath: string) => Promise<ProjectSession[]>;
  /** Reads the cue through the provider that OWNS the session — never the globally selected one. */
  resumeCue: (projectPath: string, session: ProjectSession) => Promise<string | null>;
  getEntry: (path: string) => StoreEntry;
}

function maxMs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// How many projects are enriched (git subprocesses + session reads) concurrently. Unbounded
// Promise.all launched work for EVERY project at once — at 100 projects that meant hundreds of
// simultaneous git processes per refresh, which thrashed the system far more than it parallelized.
const ENRICH_CONCURRENCY = 8;

/** Map items through an async fn with at most `limit` in flight (order-preserving). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function buildProjectList(deps: BuildDeps): Promise<ProjectViewModel[]> {
  const raw = await deps.scan();
  const models = await mapLimit(raw, ENRICH_CONCURRENCY,
    async (r): Promise<ProjectViewModel> => {
      const git = await deps.git(r.path);
      const sessions = await deps.sessions(r.path);
      const cueText = sessions[0] ? await deps.resumeCue(r.path, sessions[0]) : null;
      const lastSessionMs = sessions[0]?.mtimeMs ?? null;
      const activityMs = maxMs(git.lastCommitMs, lastSessionMs);
      const entry = deps.getEntry(r.path);
      return {
        path: r.path,
        name: r.name,
        branch: git.branch,
        uncommitted: git.uncommitted,
        ahead: git.ahead,
        lastCommitMs: git.lastCommitMs,
        lastSubject: git.lastSubject,
        lastSessionMs,
        sessions,
        sessionCount: sessions.length,
        agentIds: providerOrderFromSessions(sessions),
        activityMs,
        stale: classifyStaleness(activityMs, deps.nowMs, deps.thresholds),
        note: entry.note,
        pinned: entry.pinned,
        hidden: entry.hidden,
        lastOpened: entry.lastOpened,
        resumeCue: cueText ? ({ kind: 'lastMessage', text: cueText } satisfies ResumeCue) : null,
        repoUrl: git.repoUrl,
        todos: entry.todos,
      };
    });

  return models
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity);
    });
}
