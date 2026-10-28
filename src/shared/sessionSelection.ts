// src/shared/sessionSelection.ts
// Picking several sidebar sessions to close at once — the selection itself, kept out of the DOM.
//
// Until 1.49.0 a selection could only be started with Ctrl+click, which nothing on screen
// mentioned, so most people closed a long deck one row at a time. The sidebar now has a visible
// way in (a Select button, and "Select…" in every row's ⋯ menu) and a selection MODE: while it is
// on, every row shows a checkbox and a plain click picks the row instead of opening it. Ctrl+click
// and Shift+click keep working, in and out of the mode.

import type { ShellSessionInput } from './shellNavigation';

export interface SessionSelection {
  /** Entity keys of the picked rows, in the order they were picked. */
  keys: Set<string>;
  /** The row a Shift+click ranges from: the last row picked or un-picked. */
  anchor: string | null;
  /** Selection mode: rows show checkboxes and a plain click picks. On while anything is picked. */
  mode: boolean;
}

export function emptySelection(): SessionSelection {
  return { keys: new Set(), anchor: null, mode: false };
}

/** Enter the mode with nothing picked yet — the Select button. */
export function beginSelecting(s: SessionSelection): SessionSelection {
  return { ...s, keys: new Set(s.keys), mode: true };
}

/** Leave the mode and drop every pick — Done, Escape, or the picks having been closed. */
export function endSelecting(): SessionSelection {
  return emptySelection();
}

/** Pick a row, or un-pick a picked one; either way it becomes the range anchor. */
export function toggleKey(s: SessionSelection, key: string): SessionSelection {
  const keys = new Set(s.keys);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  return { keys, anchor: key, mode: true };
}

/**
 * Shift+click: pick everything from the anchor to this row, in the order the rail shows them
 * (`order`). Without an anchor on screen it is an ordinary pick. The anchor stays where it was, so
 * a second Shift+click re-ranges from the same start, as every file manager does.
 */
export function rangeTo(s: SessionSelection, order: readonly string[], key: string): SessionSelection {
  const a = s.anchor ? order.indexOf(s.anchor) : -1;
  const b = order.indexOf(key);
  if (a < 0 || b < 0) return toggleKey(s, key);
  const keys = new Set(s.keys);
  for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) keys.add(k);
  return { keys, anchor: s.anchor, mode: true };
}

/** Pick every row the rail shows. */
export function selectAll(s: SessionSelection, order: readonly string[]): SessionSelection {
  const keys = new Set(s.keys);
  for (const k of order) keys.add(k);
  return { keys, anchor: s.anchor, mode: true };
}

/** True when every one of these rows is picked (and there is at least one). */
export function allSelected(s: SessionSelection, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((k) => s.keys.has(k));
}

/**
 * The checkbox on a group heading: picks the whole group, or un-picks it when it is already all
 * picked. Half-picked groups fill up rather than empty — the common case is "all of these, and
 * I had already started on them".
 */
export function toggleGroup(s: SessionSelection, groupKeys: readonly string[]): SessionSelection {
  const keys = new Set(s.keys);
  if (allSelected(s, groupKeys)) for (const k of groupKeys) keys.delete(k);
  else for (const k of groupKeys) keys.add(k);
  return { keys, anchor: groupKeys.at(-1) ?? s.anchor, mode: true };
}

/**
 * Rows that left the rail (closed, folded away, cut by a "show more") leave the selection with
 * them: a pick you cannot see must not be closed on your behalf. The mode survives an empty
 * selection — it ends only on Done, Escape, or a close.
 */
export function pruneSelection(s: SessionSelection, present: ReadonlySet<string>): SessionSelection {
  let changed = false;
  const keys = new Set<string>();
  for (const k of s.keys) { if (present.has(k)) keys.add(k); else changed = true; }
  const anchor = s.anchor && present.has(s.anchor) ? s.anchor : null;
  if (!changed && anchor === s.anchor) return s;
  return { keys, anchor, mode: s.mode };
}

// ---- what a close of these rows amounts to ----

/** How many of each kind a set of rows holds, for the confirmation to say before it is answered. */
export interface CloseBreakdown {
  /** Live sessions on this PC. */
  local: number;
  /** Live sessions on other PCs, by that PC's name — each stops an agent in front of someone else. */
  remote: Map<string, number>;
  /** Claude Code background sessions (`claude stop` + `claude rm`). */
  background: number;
  /** Saved entries, which are only forgotten. */
  previous: number;
}

export function closeBreakdown(items: readonly ShellSessionInput[], ids: readonly string[]): CloseBreakdown {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: CloseBreakdown = { local: 0, remote: new Map(), background: 0, previous: 0 };
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) continue;
    if (item.backgroundAgent === true) out.background += 1;
    else if (item.previous === true) out.previous += 1;
    else if (typeof item.machineId === 'string' && item.machineId && item.machineId !== 'local') {
      const name = item.machineLabel || item.machineId;
      out.remote.set(name, (out.remote.get(name) ?? 0) + 1);
    } else out.local += 1;
  }
  return out;
}

/** The breakdown as the confirmation reads it, one phrase per kind that is present, in rail order. */
export function describeBreakdown(b: CloseBreakdown, words: {
  local(n: number): string; remote(n: number, machine: string): string; background(n: number): string; previous(n: number): string;
}): string[] {
  const parts: string[] = [];
  if (b.local > 0) parts.push(words.local(b.local));
  for (const [machine, n] of b.remote) parts.push(words.remote(n, machine));
  if (b.background > 0) parts.push(words.background(b.background));
  if (b.previous > 0) parts.push(words.previous(b.previous));
  return parts;
}
