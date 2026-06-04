import type { GitInfo, ProjectViewModel, StoreEntry, SessionMeta, StaleThresholds } from '../shared/types';
import type { RawProject } from './scanner';
import { classifyStaleness } from '../shared/staleness';

export interface BuildDeps {
  baseDir: string;
  nowMs: number;
  thresholds: StaleThresholds;
  scan: (baseDir: string) => Promise<RawProject[]>;
  git: (dir: string) => Promise<GitInfo>;
  sessions: (projectPath: string) => SessionMeta[];
  getEntry: (path: string) => StoreEntry;
}

function maxMs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export async function buildProjectList(deps: BuildDeps): Promise<ProjectViewModel[]> {
  const raw = await deps.scan(deps.baseDir);
  const models = await Promise.all(
    raw.map(async (r): Promise<ProjectViewModel> => {
      const git = await deps.git(r.path);
      const sessions = deps.sessions(r.path);
      const lastSessionMs = sessions[0]?.mtimeMs ?? null;
      const activityMs = maxMs(git.lastCommitMs, lastSessionMs);
      const entry = deps.getEntry(r.path);
      return {
        path: r.path,
        name: r.name,
        branch: git.branch,
        uncommitted: git.uncommitted,
        lastCommitMs: git.lastCommitMs,
        lastSubject: git.lastSubject,
        lastSessionMs,
        sessions,
        sessionCount: sessions.length,
        activityMs,
        stale: classifyStaleness(activityMs, deps.nowMs, deps.thresholds),
        note: entry.note,
        pinned: entry.pinned,
        hidden: entry.hidden,
      };
    }),
  );

  return models
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity);
    });
}
