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

const ACTIVITY_RANK: Record<ActivityState, number> = { attention: 0, turn: 1, working: 2, idle: 3, exited: 4 };
const BUCKET_OF: Record<ActivityState, 'attention' | 'working' | 'idle'> = { attention: 'attention', turn: 'attention', working: 'working', idle: 'idle', exited: 'idle' };
const BUCKET_ORDER = ['attention', 'working', 'idle'] as const;

export function groupByActivity(list: CockpitSession[]): { bucket: 'attention' | 'working' | 'idle'; items: CockpitSession[] }[] {
  const sorted = [...list].sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] || a.name.localeCompare(b.name));
  return BUCKET_ORDER
    .map((bucket) => ({ bucket, items: sorted.filter((s) => BUCKET_OF[s.activity] === bucket) }))
    .filter((g) => g.items.length > 0);
}

export function needsAttentionCount(list: CockpitSession[]): number {
  return list.filter((s) => s.activity === 'attention' || s.activity === 'turn').length;
}

/** The cockpit (embedded node-pty terminals) is Windows-only for now; other OSes keep the external terminal. */
export function isCockpitPlatform(platform: string): boolean {
  return platform === 'win32';
}
