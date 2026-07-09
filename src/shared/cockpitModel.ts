import type { AgentId, StaleLevel } from './types';
import type { ActivityState } from './sessionStatus';

export type SessionStatus = 'running' | 'exited';

export interface CockpitSession {
  id: string;
  projectPath: string;
  name: string;
  agentId: AgentId;
  status: SessionStatus;
  staleLevel: StaleLevel;
  branch: string | null;
  dirty: number;
  activity: ActivityState;
}

export function filterSessions(list: CockpitSession[], query: string, labels?: Map<string, string>): CockpitSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  // A renamed session shows its custom label, so search must match what the list SHOWS —
  // not just the folder name underneath it.
  return list.filter((s) =>
    s.name.toLowerCase().includes(q) || (s.branch ?? '').toLowerCase().includes(q) ||
    (labels?.get(s.id) ?? '').toLowerCase().includes(q));
}

/**
 * OS notification for "the agent is waiting on you": fire exactly on the transition INTO attention,
 * only when the user isn't already looking at the window, gated by the same setting as the tray alert.
 */
export function shouldNotifyAttention(x: { prev: ActivityState; next: ActivityState; trayAlert: 'off' | 'attention' | 'all'; windowFocused: boolean }): boolean {
  return x.next === 'attention' && x.prev !== 'attention' && x.trayAlert !== 'off' && !x.windowFocused;
}

type Bucket = 'attention' | 'working' | 'turn' | 'idle';
const ACTIVITY_RANK: Record<ActivityState, number> = { attention: 0, working: 1, turn: 2, idle: 3, exited: 4 };
// 'turn' is its own calm "Your turn" bucket (separate from "Needs you"), so an active/just-finished
// session isn't lumped with genuine agent questions and doesn't inflate the needs-you badge.
const BUCKET_OF: Record<ActivityState, Bucket> = { attention: 'attention', working: 'working', turn: 'turn', idle: 'idle', exited: 'idle' };
const BUCKET_ORDER = ['attention', 'working', 'turn', 'idle'] as const;

export function groupByActivity(list: CockpitSession[]): { bucket: Bucket; items: CockpitSession[] }[] {
  const sorted = [...list].sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] || a.name.localeCompare(b.name));
  return BUCKET_ORDER
    .map((bucket) => ({ bucket, items: sorted.filter((s) => BUCKET_OF[s.activity] === bucket) }))
    .filter((g) => g.items.length > 0);
}

/** The rail badge surfaces only sessions where the AGENT is waiting on you (a question) — not your turn / typing. */
export function needsAttentionCount(list: CockpitSession[]): number {
  return list.filter((s) => s.activity === 'attention').length;
}

/**
 * Disambiguate the session list: append a `#N` suffix (by input order) only to display names that
 * appear more than once, so a unique (e.g. custom-renamed) name is shown as-is and any two sessions
 * that would otherwise read identically become `name #1` / `name #2`.
 */
export function numberCollidingNames(names: string[]): string[] {
  const total = new Map<string, number>();
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((total.get(name) ?? 0) <= 1) return name;
    const k = (seen.get(name) ?? 0) + 1;
    seen.set(name, k);
    return `${name} #${k}`;
  });
}

/** The cockpit (embedded node-pty terminals) is Windows-only for now; other OSes keep the external terminal. */
export function isCockpitPlatform(platform: string): boolean {
  return platform === 'win32';
}

export interface CockpitRowSig {
  id: string; activity: string; label: string; dirty: number;
  branch: string | null; model: string | null; agentId: string; selected: boolean; pinned: boolean;
  ctx?: number | null; // per-session context % shown on the row (null/absent = unknown)
}

/**
 * A compact signature of everything the cockpit session list renders. renderList() compares it to the
 * previous signature and skips the full DOM rebuild when nothing visible changed — otherwise it rebuilds
 * every row on each 1s activity tick / 30s meta tick even when the result is identical. Includes the
 * language so a tr()-driven text change (group headers, buttons) still forces a rebuild. JSON encoding
 * keeps it collision-safe (values can't blur across a delimiter).
 */
export function cockpitListSignature(
  rows: CockpitRowSig[],
  prev: { key: string; label: string; agentId: string; pinned?: boolean }[],
  lang: string,
  search: string,
): string {
  return JSON.stringify([
    rows.map((x) => [x.id, x.activity, x.label, x.dirty, x.branch, x.model, x.agentId, x.selected, x.pinned, x.ctx ?? null]),
    prev.map((x) => [x.key, x.label, x.agentId, x.pinned === true]),
    lang,
    search,
  ]);
}

/** Fold live sessions to a per-project signal for the deck: attention outranks working; quiet projects are absent. */
export function foldProjectActivity(sessions: { projectPath: string; activity: ActivityState }[]): Map<string, 'attention' | 'working'> {
  const m = new Map<string, 'attention' | 'working'>();
  for (const s of sessions) {
    if (s.activity === 'attention') m.set(s.projectPath, 'attention');
    else if (s.activity === 'working' && m.get(s.projectPath) !== 'attention') m.set(s.projectPath, 'working');
  }
  return m;
}
