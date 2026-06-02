import type { GitInfo, ProjectViewModel, StoreEntry } from '../shared/types';
import type { RawProject } from './scanner';
import { classifyStaleness, DEFAULT_THRESHOLDS } from '../shared/staleness';

export interface BuildDeps {
  baseDir: string;
  nowMs: number;
  scan: (baseDir: string) => RawProject[];
  git: (dir: string) => Promise<GitInfo>;
  session: (projectPath: string) => number | null;
  getEntry: (path: string) => StoreEntry;
}

function maxMs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export async function buildProjectList(deps: BuildDeps): Promise<ProjectViewModel[]> {
  const raw = deps.scan(deps.baseDir);
  const models = await Promise.all(
    raw.map(async (r): Promise<ProjectViewModel> => {
      const git = await deps.git(r.path);
      const lastSessionMs = deps.session(r.path);
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
        activityMs,
        stale: classifyStaleness(activityMs, deps.nowMs, DEFAULT_THRESHOLDS),
        note: entry.note,
        pinned: entry.pinned,
        hidden: entry.hidden,
      };
    }),
  );

  return models
    .filter((m) => !m.hidden)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity);
    });
}
