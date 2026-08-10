import type { ActivityState } from './sessionStatus';

export interface ShellSessionInput {
  id: string;
  projectPath: string;
  label: string;
  detail: string;
  activity: ActivityState;
  pinned: boolean;
  /** What the session is working on right now (the per-turn AI summary) — the sidebar's third line. */
  summary?: string | null;
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

/** Every row action the sidebar's ⋯ menu can offer, live or previous. */
export type ShellSessionAction = 'pin' | 'unpin' | 'rename' | 'close' | 'forget';

/** Which actions a row offers. A LIVE session can be pinned, renamed, and closed exactly as it could
 *  from the old cockpit list; a not-yet-restored entry has no terminal to rename or close, so it is
 *  pinned or forgotten instead. Pin/unpin is one toggle, labelled by the row's current state. */
export function sessionActionsFor(item: ShellSessionInput): ShellSessionAction[] {
  const pin: ShellSessionAction = item.pinned ? 'unpin' : 'pin';
  return item.previous === true ? [pin, 'forget'] : [pin, 'rename', 'close'];
}

/** The status mark's SHAPE. Activity must never be carried by color alone (a monochrome or
 *  color-blind reading of the sidebar has to stay unambiguous), so every state also gets a
 *  distinct silhouette — and "working" additionally spins, which is what makes the sidebar
 *  read as live rather than static. */
export type ShellStatusShape = 'spinner' | 'diamond' | 'ring' | 'dot' | 'square';

export function sessionStatusShape(item: ShellSessionInput): ShellStatusShape {
  if (item.conversationGone === true) return 'square';
  if (item.activity === 'attention') return 'diamond';
  if (item.activity === 'working') return 'spinner';
  if (item.activity === 'turn') return 'ring';
  if (item.activity === 'exited') return 'square';
  return 'dot';
}

/** Counts for the collapsed sidebar's status pill — collapsing to reclaim terminal width must not
 *  hide the fact that a session is waiting on you. */
export function sessionStatusCounts(items: readonly ShellSessionInput[]): { attention: number; working: number } {
  return {
    attention: items.filter((item) => item.activity === 'attention').length,
    working: items.filter((item) => item.activity === 'working').length,
  };
}

/** The row renders its summary as a third line, so assistive tech has to hear it too — the row is a
 *  single button whose aria-label replaces its contents. */
export function sessionAccessibleLabel(item: ShellSessionInput, localizedStatus: string): string {
  const base = `${item.label}, ${item.detail}, ${localizedStatus}`;
  return item.summary ? `${base}, ${item.summary}` : base;
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
