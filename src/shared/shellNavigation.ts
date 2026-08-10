import type { ActivityState } from './sessionStatus';

export interface ShellSessionInput {
  id: string;
  projectPath: string;
  label: string;
  detail: string;
  activity: ActivityState;
  pinned: boolean;
  previous?: boolean;
  conversationGone?: boolean;
}

export interface ShellProjectInput {
  path: string;
  name: string;
  branch: string | null;
}

export type ShellGroupKind = 'attention' | 'working' | 'pinned' | 'turn' | 'quiet' | 'previous';

export interface ShellSessionGroup {
  kind: ShellGroupKind;
  items: ShellSessionInput[];
}

export type ShellViewId = 'projects' | 'next' | 'usage' | 'settings';
export type ShellContext =
  | { kind: 'view'; id: ShellViewId }
  | { kind: 'project'; path: string }
  | { kind: 'session'; id: string };

export function shellEntityKey(kind: 'project' | 'session', id: string): string {
  return `${kind}:${id}`;
}

export function sessionAccessibleLabel(item: ShellSessionInput, localizedStatus: string): string {
  return `${item.label}, ${item.detail}, ${localizedStatus}`;
}

const groupOrder: ShellGroupKind[] = ['attention', 'working', 'pinned', 'turn', 'quiet', 'previous'];

function groupOf(item: ShellSessionInput): ShellGroupKind {
  if (item.activity === 'attention') return 'attention';
  if (item.activity === 'working') return 'working';
  if (item.pinned) return 'pinned';
  if (item.previous) return 'previous';
  if (item.activity === 'turn') return 'turn';
  return 'quiet';
}

export function buildSessionGroups(items: ShellSessionInput[]): ShellSessionGroup[] {
  return groupOrder.flatMap((kind) => {
    const grouped = items
      .filter((item) => groupOf(item) === kind)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return grouped.length ? [{ kind, items: grouped }] : [];
  });
}

export function attentionCount(items: ShellSessionInput[]): number {
  return items.filter((item) => item.activity === 'attention').length;
}

export function normalizeSidebarState(value: unknown): boolean {
  return value === true;
}

export function filterShellItems(
  query: string,
  sessions: ShellSessionInput[],
  projects: ShellProjectInput[],
): { sessions: ShellSessionInput[]; projects: ShellProjectInput[] } {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return { sessions: [...sessions], projects: [...projects] };
  return {
    sessions: sessions.filter((item) => `${item.label}\n${item.detail}`.toLocaleLowerCase().includes(normalized)),
    projects: projects.filter((item) => `${item.name}\n${item.branch ?? ''}`.toLocaleLowerCase().includes(normalized)),
  };
}

const viewIds = new Set<ShellViewId>(['projects', 'next', 'usage', 'settings']);

export function restoreShellContext(
  saved: unknown,
  availableProjectPaths: Set<string>,
  availableSessionIds: Set<string>,
): ShellContext {
  if (!saved || typeof saved !== 'object') return { kind: 'view', id: 'projects' };
  const candidate = saved as Partial<ShellContext> & { path?: unknown; id?: unknown };
  if (candidate.kind === 'view' && typeof candidate.id === 'string' && viewIds.has(candidate.id as ShellViewId)) {
    return { kind: 'view', id: candidate.id as ShellViewId };
  }
  if (candidate.kind === 'project' && typeof candidate.path === 'string' && availableProjectPaths.has(candidate.path)) {
    return { kind: 'project', path: candidate.path };
  }
  if (candidate.kind === 'session' && typeof candidate.id === 'string' && availableSessionIds.has(candidate.id)) {
    return { kind: 'session', id: candidate.id };
  }
  return { kind: 'view', id: 'projects' };
}
