import type { AgentId, ProjectMemory, ProjectMemoryEvent } from '../shared/types';

export type MemoryAction =
  | { kind: 'session'; sessionId: string; agentId: AgentId }
  | { kind: 'copy'; text: string }
  | { kind: 'tasks' };

export interface SnapshotRow {
  kind: 'continue' | 'working-tree' | 'latest-change' | 'tasks' | 'note';
  labelKey: string;
  value?: string;
  valueKey?: string;
  vars?: Record<string, string | number>;
  detail?: string | null;
  at?: number;
  items?: string[];
  count?: number;
  action?: MemoryAction;
  agentId?: AgentId;
}

export interface TimelineRow {
  id: string;
  kind: ProjectMemoryEvent['kind'];
  at: number;
  title: string;
  titleKey?: string;
  detail: string | null;
  agentId?: AgentId;
  action: MemoryAction | null;
  done?: boolean;
  due?: string | null;
}

export function snapshotRows(memory: ProjectMemory, _now: number): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const resume = memory.snapshot.continueFrom;
  if (resume) rows.push({
    kind: 'continue', labelKey: 'memory.continue_from', value: resume.text, at: resume.at,
    agentId: resume.agentId, action: { kind: 'session', sessionId: resume.sessionId, agentId: resume.agentId },
  });
  const git = memory.snapshot.git;
  const dirty = Math.max(0, git.uncommitted | 0);
  const ahead = Math.max(0, git.ahead ?? 0);
  rows.push({
    kind: 'working-tree', labelKey: 'memory.working_tree',
    valueKey: dirty || ahead ? 'memory.working_state' : 'memory.clean',
    vars: { branch: git.branch ?? '—', dirty, ahead },
  });
  if (git.latestCommit) rows.push({
    kind: 'latest-change', labelKey: 'memory.latest_change', value: git.latestCommit.subject,
    detail: git.latestCommit.hash, at: git.latestCommit.at,
    action: { kind: 'copy', text: git.latestCommit.hash },
  });
  if (memory.snapshot.nextTasks.length) rows.push({
    kind: 'tasks', labelKey: 'memory.next_tasks', items: memory.snapshot.nextTasks.map((t) => t.text),
    count: memory.snapshot.nextTasks.length + memory.snapshot.remainingTaskCount,
    vars: { remaining: memory.snapshot.remainingTaskCount }, action: { kind: 'tasks' },
  });
  if (memory.snapshot.note) rows.push({ kind: 'note', labelKey: 'memory.project_note', value: memory.snapshot.note });
  return rows;
}

export function timelineRows(memory: ProjectMemory): TimelineRow[] {
  return memory.events.map((event): TimelineRow => {
    if (event.kind === 'session') return {
      id: event.id, kind: event.kind, at: event.at,
      title: event.lastUserMessage?.trim() || event.firstMessage?.trim() || '',
      titleKey: event.lastUserMessage || event.firstMessage ? undefined : 'memory.no_message',
      detail: event.lastUserMessage && event.firstMessage ? event.firstMessage : null,
      agentId: event.agentId,
      action: { kind: 'session', sessionId: event.sessionId, agentId: event.agentId },
    };
    if (event.kind === 'commit') return {
      id: event.id, kind: event.kind, at: event.at, title: event.subject, detail: event.hash,
      action: { kind: 'copy', text: event.hash },
    };
    if (event.kind === 'task-created') return {
      id: event.id, kind: event.kind, at: event.at, title: event.text, detail: null,
      action: { kind: 'tasks' }, done: event.done, due: event.due,
    };
    return {
      id: event.id, kind: event.kind, at: event.at, title: '', titleKey: 'memory.project_opened', detail: null, action: null,
    };
  });
}
