import { cwdKey } from '../shared/paths';
import { buildProjectMemory } from '../shared/projectMemory';
import type {
  GitInfo, ProjectMemory, ProjectMemorySession, ProjectSession, RecentCommit, StoreEntry,
} from '../shared/types';

const CACHE_MS = 15_000;
const SESSION_LIMIT = 10;
const MESSAGE_CONCURRENCY = 3;

const EMPTY_GIT: GitInfo = {
  branch: null, lastCommitMs: null, lastSubject: null, uncommitted: 0, ahead: null, repoUrl: null,
};

export interface ProjectMemoryDeps {
  now: () => number;
  gitInfo: (path: string) => Promise<GitInfo>;
  commits: (path: string) => Promise<RecentCommit[]>;
  sessions: (path: string, limit: number) => Promise<ProjectSession[]>;
  lastUserMessage: (path: string, session: ProjectSession) => Promise<string | null>;
  entry: (path: string) => StoreEntry;
}

export interface ProjectMemoryService {
  get(path: string, fresh?: boolean): Promise<ProjectMemory>;
}

/** Neutral response for a rejected path: stable shape without revealing any project facts. */
export function emptyProjectMemory(projectPath = ''): ProjectMemory {
  return {
    projectPath,
    generatedAt: 0,
    snapshot: {
      continueFrom: null,
      git: { branch: null, uncommitted: 0, ahead: null, latestCommit: null },
      nextTasks: [], remainingTaskCount: 0, note: null,
    },
    events: [],
    partial: ['git', 'sessions'],
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadProjectMemory(path: string, deps: ProjectMemoryDeps): Promise<ProjectMemory> {
  const partial: Array<'git' | 'sessions'> = [];
  let git = EMPTY_GIT;
  let commits: RecentCommit[] = [];
  const [gitResult, commitResult] = await Promise.allSettled([deps.gitInfo(path), deps.commits(path)]);
  if (gitResult.status === 'fulfilled') git = gitResult.value;
  if (commitResult.status === 'fulfilled') commits = commitResult.value;
  if (gitResult.status === 'rejected' || commitResult.status === 'rejected') partial.push('git');

  let sessions: ProjectSession[] = [];
  try {
    sessions = (await deps.sessions(path, SESSION_LIMIT)).slice(0, SESSION_LIMIT);
  } catch {
    partial.push('sessions');
  }
  const enriched: ProjectMemorySession[] = await mapLimit(sessions, MESSAGE_CONCURRENCY, async (session) => {
    let lastUserMessage: string | null = null;
    try { lastUserMessage = await deps.lastUserMessage(path, session); } catch { /* one unreadable log does not hide its session */ }
    return { ...session, lastUserMessage };
  });

  return buildProjectMemory({
    projectPath: path,
    generatedAt: deps.now(),
    git,
    commits,
    sessions: enriched,
    entry: deps.entry(path),
    partial,
  });
}

export function makeProjectMemoryService(deps: ProjectMemoryDeps): ProjectMemoryService {
  const cache = new Map<string, { expiresAt: number; promise: Promise<ProjectMemory> }>();
  return {
    get(path: string, fresh = false): Promise<ProjectMemory> {
      const key = cwdKey(path);
      if (fresh) cache.delete(key);
      const hit = cache.get(key);
      const now = deps.now();
      if (hit && hit.expiresAt > now) return hit.promise;
      const promise = loadProjectMemory(path, deps);
      cache.set(key, { expiresAt: now + CACHE_MS, promise });
      return promise;
    },
  };
}
