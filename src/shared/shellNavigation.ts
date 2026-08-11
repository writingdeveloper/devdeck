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
  /** Epoch ms of this session's last activity — what the list is ORDERED by. Absent = never observed. */
  lastActiveMs?: number | null;
  previous?: boolean;
  conversationGone?: boolean;
}

export interface ShellProjectInput {
  path: string;
  name: string;
  branch: string | null;
  /** The deck's pin. A pinned project is never truncated away by the "recent N" cut. */
  pinned?: boolean;
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

/**
 * Order inside every group: MOST RECENTLY ACTIVE FIRST, name only as a tie-break.
 *
 * Alphabetical order was the root of the "pin of a pin" problem. A pin means two different things to
 * the user — "this is what I'm on right now" and "don't let me lose this" — and with an alphabetical
 * pinned group the first meaning has no way to express itself, so the session they touched a minute ago
 * sits wherever its name lands and the group reads as an undifferentiated pile. Recency answers "what
 * am I on" automatically, which leaves the pin to mean only "don't lose this".
 *
 * A session with no observed activity (an older saved entry from before this was persisted) sorts after
 * every timestamped one rather than jumping to the top, and those fall back to name order among
 * themselves so their relative order is at least stable.
 */
export function compareSessionsByRecency(a: ShellSessionInput, b: ShellSessionInput): number {
  const at = a.lastActiveMs ?? null;
  const bt = b.lastActiveMs ?? null;
  if (at !== bt) {
    if (at == null) return 1;
    if (bt == null) return -1;
    return bt - at;
  }
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

export function buildSessionGroups(items: ShellSessionInput[]): ShellSessionGroup[] {
  return groupOrder.flatMap((kind) => {
    const grouped = items.filter((item) => groupOf(item) === kind).sort(compareSessionsByRecency);
    return grouped.length ? [{ kind, items: grouped }] : [];
  });
}

/** Where a row lives now — and, given a modified copy, where an action would MOVE it. */
export function sessionGroupOf(item: ShellSessionInput): ShellGroupKind {
  return groupOf(item);
}

/**
 * The group an unpin would drop this row into. Unpinning was the scariest action in the sidebar for
 * exactly one reason: nothing told the user where the row went, so "unpin" felt like "delete" and pins
 * accumulated forever. The caller names this group in the confirmation toast.
 */
export function unpinDestination(item: ShellSessionInput): ShellGroupKind {
  return groupOf({ ...item, pinned: false });
}

export function attentionCount(items: ShellSessionInput[]): number {
  return items.filter((item) => item.activity === 'attention').length;
}

const collapsibleGroups = new Set<string>(groupOrder);

/** Sanitize the persisted set of folded group headers (localStorage is user-writable and survives
 *  downgrades, so an unknown kind must be dropped rather than rendered). */
export function normalizeCollapsedGroups(value: unknown): ShellGroupKind[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ShellGroupKind>();
  for (const entry of value) {
    if (typeof entry === 'string' && collapsibleGroups.has(entry)) seen.add(entry as ShellGroupKind);
  }
  return groupOrder.filter((kind) => seen.has(kind));
}

export function toggleCollapsedGroup(current: readonly ShellGroupKind[], kind: ShellGroupKind): ShellGroupKind[] {
  return current.includes(kind)
    ? current.filter((entry) => entry !== kind)
    : normalizeCollapsedGroups([...current, kind]);
}

/**
 * Cut a long list down to a head of `limit`, keeping anything `keep` protects no matter how far down it
 * sits. Two lists in the sidebar are unbounded — restorable sessions (up to 50) and projects (100+ for
 * this user) — and an always-full render buries every other section under them. `hidden` drives the
 * "show N more" control, so nothing is ever silently dropped.
 */
export function truncateList<T>(
  items: readonly T[],
  opts: { limit: number; expanded: boolean; keep?: (item: T) => boolean },
): { shown: T[]; hidden: number } {
  if (opts.expanded || items.length <= opts.limit) return { shown: [...items], hidden: 0 };
  const shown = items.filter((item, index) => index < opts.limit || opts.keep?.(item) === true);
  return { shown, hidden: items.length - shown.length };
}

export function normalizeSidebarState(value: unknown): boolean {
  return value === true;
}

/**
 * The sidebar's width in pixels.
 *
 * A session row shows branch + working-tree count + provider + model + context %, and its third line
 * is a sentence — none of that fits in a fixed 224px, so every row ended in an ellipsis regardless of
 * how much window the user had spare. The width is a stored preference; these bounds keep it useful at
 * both ends (below ~180px the three lines stop being readable at all, and past ~460px the rail starts
 * eating the terminal it exists to point at).
 */
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 460;
export const SIDEBAR_WIDTH_DEFAULT = 224;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

/** Restore a persisted width, falling back to the default for anything unusable. */
export function normalizeSidebarWidth(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? clampSidebarWidth(parsed) : SIDEBAR_WIDTH_DEFAULT;
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
