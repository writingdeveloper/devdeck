import type { AgentId, StaleLevel } from './types';

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
}

export function filterSessions(list: CockpitSession[], query: string): CockpitSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((s) =>
    s.name.toLowerCase().includes(q) || (s.branch ?? '').toLowerCase().includes(q));
}

export function sortSessions(list: CockpitSession[]): CockpitSession[] {
  const rank = (s: CockpitSession) => (s.status === 'running' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const ORDER: SessionStatus[] = ['running', 'exited'];

export function groupSessions(list: CockpitSession[]): { status: SessionStatus; items: CockpitSession[] }[] {
  const sorted = sortSessions(list);
  return ORDER
    .map((status) => ({ status, items: sorted.filter((s) => s.status === status) }))
    .filter((g) => g.items.length > 0);
}

/** The cockpit (embedded node-pty terminals) is Windows-only for now; other OSes keep the external terminal. */
export function isCockpitPlatform(platform: string): boolean {
  return platform === 'win32';
}
