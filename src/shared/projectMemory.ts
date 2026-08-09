import { classifyDue } from './tasks';
import type {
  GitInfo, ProjectMemory, ProjectMemoryEvent, ProjectMemorySession,
  RecentCommit, StoreEntry,
} from './types';

export interface ProjectMemoryInput {
  projectPath: string;
  generatedAt: number;
  git: GitInfo;
  commits: RecentCommit[];
  sessions: ProjectMemorySession[];
  entry: StoreEntry;
  partial: Array<'git' | 'sessions'>;
}

/** Parse records emitted by `%h%x1f%at%x1f%s%x1e`; malformed records never reach the renderer. */
export function parseRecentCommits(raw: string): RecentCommit[] {
  return raw.split('\u001e').flatMap((record) => {
    const [hash, seconds, ...subjectParts] = record.trim().split('\u001f');
    const at = Number(seconds) * 1000;
    const subject = subjectParts.join('\u001f').trim();
    return /^[0-9a-f]{4,40}$/i.test(hash ?? '') && Number.isFinite(at) && at > 0 && subject
      ? [{ hash, at, subject }]
      : [];
  });
}

function nextTasks(entry: StoreEntry, now: number): { tasks: StoreEntry['todos']; remaining: number } {
  const rank = { overdue: 0, today: 1, week: 2, later: 3, none: 4 } as const;
  const open = entry.todos.filter((t) => !t.done).sort((a, b) => {
    const ar = rank[classifyDue(a.due, now)], br = rank[classifyDue(b.due, now)];
    return ar - br || (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99') || a.createdAt.localeCompare(b.createdAt);
  });
  return { tasks: open.slice(0, 3), remaining: Math.max(0, open.length - 3) };
}

function validAt(value: string | null): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Deterministic local facts only: no inference about whether a request or task was completed. */
export function buildProjectMemory(input: ProjectMemoryInput): ProjectMemory {
  const sessions = [...input.sessions].sort((a, b) => b.mtimeMs - a.mtimeMs || a.agentId.localeCompare(b.agentId) || a.id.localeCompare(b.id));
  const newest = sessions[0] ?? null;
  const continueText = newest?.lastUserMessage?.trim() || newest?.firstMessage?.trim() || null;
  const tasks = nextTasks(input.entry, input.generatedAt);
  const commits = input.commits.filter((c) => Number.isFinite(c.at) && c.at > 0);
  const latestCommit = commits.reduce<RecentCommit | null>((best, c) => (!best || c.at > best.at ? c : best), null);
  const events: ProjectMemoryEvent[] = [
    ...sessions.filter((s) => Number.isFinite(s.mtimeMs) && s.mtimeMs > 0).map((s): ProjectMemoryEvent => ({
      id: `session:${s.agentId}:${s.id}`, kind: 'session', at: s.mtimeMs,
      agentId: s.agentId, sessionId: s.id, firstMessage: s.firstMessage, lastUserMessage: s.lastUserMessage,
    })),
    ...commits.map((c): ProjectMemoryEvent => ({ id: `commit:${c.hash}`, kind: 'commit', ...c })),
    ...input.entry.todos.flatMap((t): ProjectMemoryEvent[] => {
      const at = validAt(t.createdAt);
      return at == null ? [] : [{ id: `task:${t.id}`, kind: 'task-created', at, todoId: t.id, text: t.text, done: t.done, due: t.due }];
    }),
  ];
  const openedAt = validAt(input.entry.lastOpened);
  if (openedAt != null) events.push({ id: 'project-opened:last', kind: 'project-opened', at: openedAt });
  events.sort((a, b) => b.at - a.at || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  return {
    projectPath: input.projectPath,
    generatedAt: input.generatedAt,
    snapshot: {
      continueFrom: newest && continueText
        ? { text: continueText, agentId: newest.agentId, sessionId: newest.id, at: newest.mtimeMs }
        : null,
      git: {
        branch: input.git.branch,
        uncommitted: input.git.uncommitted,
        ahead: input.git.ahead,
        latestCommit,
      },
      nextTasks: tasks.tasks,
      remainingTaskCount: tasks.remaining,
      note: input.entry.note.trim() || null,
    },
    events: events.slice(0, 40),
    partial: [...input.partial],
  };
}
