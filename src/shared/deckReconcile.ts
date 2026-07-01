// Pure helpers for the projects deck's in-place (flicker-free) refresh. The renderer
// keeps a path-keyed cache of card DOM nodes; on each refresh it reuses the node for any
// project whose *displayed* values are unchanged and only rebuilds the ones that changed.
// `projectSignature` collapses a project's rendered state into one comparable string;
// `diffCards` decides, from the previous signatures and the desired list, what to reuse,
// rebuild, or remove. Keeping this logic pure makes it unit-testable without the DOM.

export interface SignatureInput {
  stale: { level: string; ageDays: number | null };
  name: string;
  branch: string | null;
  uncommitted: number;
  ahead: number | null;
  lastCommitMs: number | null;
  lastSubject: string | null;
  lastSessionMs: number | null;
  sessionCount: number;
  activityMs: number | null;
  note: string;
  resumeCue: { text: string } | null;
  repoUrl: string | null;
  pinned: boolean;
  hidden: boolean;
  todos: { id: string; done: boolean; due: string | null }[];
}

export interface SignatureUiState {
  // Session-list expand state — drives card *content*, toggled via a re-render.
  expanded: boolean;
  // undefined = cost not scanned yet, null = scanned but no cost — both render as nothing.
  cost: number | null | undefined;
  showHidden: boolean;
  viewMode: 'cards' | 'list';
}
// NOTE: selection is intentionally NOT part of the signature. It toggles a class directly
// (no re-render) and is re-derived from `selected.has(path)` whenever a card is rebuilt, so
// including it would only force a needless rebuild of that card on the next refresh.

// Unit-separator delimiter — won't collide with branch names, commit subjects, or notes.
const SEP = '␟';

/**
 * A stable string of everything either deck view renders for one project. Equal signatures
 * ⇒ identical visible output ⇒ the existing DOM node can be reused untouched. Order in the
 * list is intentionally NOT encoded — reordering is handled by moving nodes, not rebuilding.
 */
export function projectSignature(p: SignatureInput, ui: SignatureUiState): string {
  return [
    p.stale.level,
    p.stale.ageDays ?? '',
    p.name,
    p.branch ?? '',
    p.uncommitted,
    p.ahead ?? 0,
    p.lastCommitMs ?? '',
    p.lastSubject ?? '',
    p.lastSessionMs ?? '',
    p.sessionCount,
    p.activityMs ?? '',
    p.note,
    p.resumeCue?.text ?? '',
    p.repoUrl ?? '',
    p.pinned ? 1 : 0,
    p.hidden ? 1 : 0,
    // Task badge: rebuild the card when a todo is added/checked/re-dated/removed (done/total + due drive
    // the badge). Overdue is time-derived and read at render — a midnight rollover on an otherwise-
    // unchanged project may lag one edit, which is acceptable for a count badge.
    p.todos.map((t) => `${t.id}:${t.done ? 1 : 0}:${t.due ?? ''}`).join('|'),
    ui.expanded ? 1 : 0,
    ui.showHidden ? 1 : 0,
    ui.viewMode,
    ui.cost == null ? '' : ui.cost.toFixed(2),
  ].join(SEP);
}

export interface DiffResult {
  /** Keys present last time with an identical signature and still desired — reuse the node. */
  reuse: Set<string>;
  /** Desired keys that are new or whose signature changed — need a fresh node, in desired order. */
  rebuild: string[];
  /** Keys present last time but no longer desired — drop the node. */
  remove: string[];
}

/** Decide which cached cards to reuse, rebuild, or remove for the next render. */
export function diffCards(prev: Map<string, string>, desired: { key: string; sig: string }[]): DiffResult {
  const reuse = new Set<string>();
  const rebuild: string[] = [];
  const desiredKeys = new Set<string>();
  for (const { key, sig } of desired) {
    desiredKeys.add(key);
    if (prev.get(key) === sig) reuse.add(key);
    else rebuild.push(key);
  }
  const remove: string[] = [];
  for (const key of prev.keys()) {
    if (!desiredKeys.has(key)) remove.push(key);
  }
  return { reuse, rebuild, remove };
}
