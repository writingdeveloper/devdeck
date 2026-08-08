import type { LocalProjectUsage, LocalUsageProvider } from './localUsage';
import { addTotals, emptyTotals, type UsageTotals } from './usage';

/** Case-insensitive substring match on project name; empty/whitespace query = no filtering. */
export function filterProjectRows(rows: LocalProjectUsage[], query: string): LocalProjectUsage[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => p.name.toLowerCase().includes(q));
}

export interface DeletedGroup {
  count: number;
  sessions: number;
  totals: UsageTotals;
  costEstimate: number | null;
  activeMs: number;
  hasUnknownModel: boolean;
  providerCosts: Partial<Record<LocalUsageProvider, number | null>>;
}

/**
 * Fold every 'deleted' project row into a single group so the Usage table shows deleted projects as one
 * collapsed row instead of an ever-growing list (~/.claude keeps a dir per deleted project forever).
 * Returns null when there are no deleted rows. Cost sums the rows that HAVE a price card (null only when
 * none do), mirroring how the global total reports partial cost alongside an unknown-model flag.
 */
export function aggregateDeleted(rows: LocalProjectUsage[]): DeletedGroup | null {
  const del = rows.filter((p) => p.status === 'deleted');
  if (!del.length) return null;
  let totals = emptyTotals();
  let sessions = 0, activeMs = 0, cost = 0, anyCost = false, unknown = false;
  const providerCosts: Partial<Record<LocalUsageProvider, number | null>> = {};
  const providerHasCost: Partial<Record<LocalUsageProvider, boolean>> = {};
  for (const p of del) {
    totals = addTotals(totals, p.totals);
    sessions += p.sessions;
    activeMs += p.activeMs;
    if (p.costEstimate != null) { cost += p.costEstimate; anyCost = true; }
    if (p.hasUnknownModel) unknown = true;
    for (const providerId of ['claude', 'codex'] as const) {
      const providerCost = p.providerCosts[providerId];
      if (providerCost != null) {
        providerCosts[providerId] = (providerCosts[providerId] ?? 0) + providerCost;
        providerHasCost[providerId] = true;
      } else if (providerId in p.providerCosts && !providerHasCost[providerId]) {
        providerCosts[providerId] = null;
      }
    }
  }
  return { count: del.length, sessions, totals, costEstimate: anyCost ? cost : null, activeMs, hasUnknownModel: unknown, providerCosts };
}
