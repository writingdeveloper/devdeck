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

export function filterSessions(list: CockpitSession[], query: string): CockpitSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((s) =>
    s.name.toLowerCase().includes(q) || (s.branch ?? '').toLowerCase().includes(q));
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

/** Display labels for the session list: a `#N` suffix (by input order) only where a project has >1 session. */
export function labelByProject(items: { projectPath: string; name: string }[]): string[] {
  const total = new Map<string, number>();
  for (const it of items) total.set(it.projectPath, (total.get(it.projectPath) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((it) => {
    if ((total.get(it.projectPath) ?? 0) <= 1) return it.name;
    const n = (seen.get(it.projectPath) ?? 0) + 1;
    seen.set(it.projectPath, n);
    return `${it.name} #${n}`;
  });
}

/** The cockpit (embedded node-pty terminals) is Windows-only for now; other OSes keep the external terminal. */
export function isCockpitPlatform(platform: string): boolean {
  return platform === 'win32';
}
