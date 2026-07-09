import type { ProjectUsage } from './types';

/** Case-insensitive substring match on project name; empty/whitespace query = no filtering. */
export function filterProjectRows(rows: ProjectUsage[], query: string): ProjectUsage[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => p.name.toLowerCase().includes(q));
}
