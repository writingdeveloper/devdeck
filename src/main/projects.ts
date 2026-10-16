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
  /** How many sessions the project has in all, when it differs from the (capped) list above. */
  sessionCount?: (projectPath: string) => Promise<number>;
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

/** The fields of a deck row that come from the user's own store entry rather than from disk and git. */
type EntryFields = 'note' | 'pinned' | 'hidden' | 'lastOpened' | 'todos' | 'todosRevision' | 'noteRevision';
/** A deck row before the store entry is laid over it: everything git and the session stores said. */
export type GatheredProject = Omit<ProjectViewModel, EntryFields>;

/**
 * The expensive half of the deck list: git and the session stores, for every scanned project.
 *
 * Split from the store entries (below) so it can be SHARED: one refresh, a window-focus refresh on top
 * of it and a paired machine polling the same deck all used to run every project's git commands and
 * session reads side by side. What they share has to be the same for all of them, and the store entry
 * is not — a pin toggled while a gather is running must show in the list that answers after it.
 */
export async function gatherProjects(deps: Omit<BuildDeps, 'getEntry'>): Promise<GatheredProject[]> {
  const raw = await deps.scan();
  return mapLimit(raw, ENRICH_CONCURRENCY,
    async (r): Promise<GatheredProject> => {
      const git = await deps.git(r.path);
      const sessions = await deps.sessions(r.path);
      const cueText = sessions[0] ? await deps.resumeCue(r.path, sessions[0]) : null;
      const lastSessionMs = sessions[0]?.mtimeMs ?? null;
      const activityMs = maxMs(git.lastCommitMs, lastSessionMs);
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
        // The list is the newest few; the count is all of them. Using the list's length capped every
        // card at "5 sessions" however many there were.
        sessionCount: deps.sessionCount ? Math.max(sessions.length, await deps.sessionCount(r.path).catch(() => sessions.length)) : sessions.length,
        agentIds: providerOrderFromSessions(sessions),
        activityMs,
        stale: classifyStaleness(activityMs, deps.nowMs, deps.thresholds),
        resumeCue: cueText ? ({ kind: 'lastMessage', text: cueText } satisfies ResumeCue) : null,
        repoUrl: git.repoUrl,
      };
    });
}

/**
 * Lay each project's store entry over what was gathered, as it is NOW, and sort (pins first).
 * Builds new rows — the gathered ones may be shared with another caller — with the keys in the order
 * the deck has always received them.
 */
export function withEntries(gathered: GatheredProject[], getEntry: BuildDeps['getEntry']): ProjectViewModel[] {
  return gathered
    .map((g): ProjectViewModel => {
      const entry = getEntry(g.path);
      return {
        path: g.path,
        name: g.name,
        branch: g.branch,
        uncommitted: g.uncommitted,
        ahead: g.ahead,
        lastCommitMs: g.lastCommitMs,
        lastSubject: g.lastSubject,
        lastSessionMs: g.lastSessionMs,
        sessions: g.sessions,
        sessionCount: g.sessionCount,
        agentIds: g.agentIds,
        activityMs: g.activityMs,
        stale: g.stale,
        note: entry.note,
        pinned: entry.pinned,
        hidden: entry.hidden,
        lastOpened: entry.lastOpened,
        resumeCue: g.resumeCue,
        repoUrl: g.repoUrl,
        todos: entry.todos,
        todosRevision: entry.todosRevision ?? 0,
        noteRevision: entry.noteRevision ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity);
    });
}

export async function buildProjectList(deps: BuildDeps): Promise<ProjectViewModel[]> {
  return withEntries(await gatherProjects(deps), deps.getEntry);
}
