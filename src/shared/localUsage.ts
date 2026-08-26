import { addTotals, emptyTotals, type UsageTotals } from './usage';
import { cwdKey } from './paths';

export type LocalUsageProvider = 'claude' | 'codex';
export type LocalUsageFilter = 'all' | LocalUsageProvider;
export type LocalUsageState = 'ready' | 'error';

export interface LocalModelUsage {
  providerId: LocalUsageProvider;
  model: string;
  totals: UsageTotals;
  costEstimate: number | null;
  hasUnknownPrice: boolean;
}

export interface LocalProjectUsage {
  path: string;
  name: string;
  sessions: number;
  totals: UsageTotals;
  costEstimate: number | null;
  hasUnknownModel: boolean;
  activeMs: number;
  status: 'active' | 'deleted';
  providerCosts: Partial<Record<LocalUsageProvider, number | null>>;
}

export interface LocalDailyUsage {
  day: string;
  tokens: number;
  cost: number | null;
  providerTokens: Partial<Record<LocalUsageProvider, number>>;
  providerCosts: Partial<Record<LocalUsageProvider, number | null>>;
}

export interface UsageAggregate {
  global: UsageTotals;
  globalCost: number | null;
  hasUnknownModel: boolean;
  webSearch: number;
  webFetch: number;
  sessions: number;
  activeMs: number;
  byModel: LocalModelUsage[];
  byProject: LocalProjectUsage[];
  daily: LocalDailyUsage[];
}

export interface ProviderUsageSlice extends UsageAggregate {
  providerId: LocalUsageProvider;
  state: LocalUsageState;
}

export type ProviderUsageSummary = ProviderUsageSlice;

export interface LocalUsageReport extends UsageAggregate {
  byProvider: ProviderUsageSlice[];
}

export function emptyProviderUsage(providerId: LocalUsageProvider, state: LocalUsageState = 'ready'): ProviderUsageSlice {
  return {
    providerId, state, global: emptyTotals(), globalCost: null, hasUnknownModel: false,
    webSearch: 0, webFetch: 0, sessions: 0, activeMs: 0, byModel: [], byProject: [], daily: [],
  };
}

function sumKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function mergeProjects(slices: ProviderUsageSlice[]): LocalProjectUsage[] {
  const rows = new Map<string, LocalProjectUsage>();
  for (const slice of slices) for (const project of slice.byProject) {
    const key = cwdKey(project.path);
    const current = rows.get(key);
    if (!current) {
      rows.set(key, {
        ...project,
        totals: { ...project.totals },
        providerCosts: { ...project.providerCosts, [slice.providerId]: project.costEstimate },
      });
      continue;
    }
    current.sessions += project.sessions;
    current.totals = addTotals(current.totals, project.totals);
    current.activeMs += project.activeMs;
    current.hasUnknownModel ||= project.hasUnknownModel;
    current.status = current.status === 'active' || project.status === 'active' ? 'active' : 'deleted';
    current.providerCosts[slice.providerId] = project.costEstimate;
    current.costEstimate = sumKnown(Object.values(current.providerCosts));
  }
  return [...rows.values()];
}

function mergeDaily(slices: ProviderUsageSlice[]): LocalDailyUsage[] {
  const rows = new Map<string, LocalDailyUsage>();
  for (const slice of slices) for (const day of slice.daily) {
    const current = rows.get(day.day) ?? { day: day.day, tokens: 0, cost: null, providerTokens: {}, providerCosts: {} };
    current.tokens += day.tokens;
    current.providerTokens[slice.providerId] = (current.providerTokens[slice.providerId] ?? 0) + day.tokens;
    current.providerCosts[slice.providerId] = day.cost;
    current.cost = sumKnown(Object.values(current.providerCosts));
    rows.set(day.day, current);
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function combineProviderUsage(input: ProviderUsageSlice[]): LocalUsageReport {
  const order: LocalUsageProvider[] = ['claude', 'codex'];
  const slices = [...input].sort((a, b) => order.indexOf(a.providerId) - order.indexOf(b.providerId));
  return {
    global: slices.reduce((totals, slice) => addTotals(totals, slice.global), emptyTotals()),
    globalCost: sumKnown(slices.map((slice) => slice.globalCost)),
    hasUnknownModel: slices.some((slice) => slice.hasUnknownModel),
    webSearch: slices.reduce((sum, slice) => sum + slice.webSearch, 0),
    webFetch: slices.reduce((sum, slice) => sum + slice.webFetch, 0),
    sessions: slices.reduce((sum, slice) => sum + slice.sessions, 0),
    activeMs: slices.reduce((sum, slice) => sum + slice.activeMs, 0),
    byModel: slices.flatMap((slice) => slice.byModel),
    byProject: mergeProjects(slices),
    daily: mergeDaily(slices),
    byProvider: slices,
  };
}

export function selectProviderUsage(report: LocalUsageReport, filter: LocalUsageFilter): UsageAggregate {
  if (filter === 'all') return report;
  return report.byProvider.find((slice) => slice.providerId === filter) ?? emptyProviderUsage(filter);
}

/**
 * The UTC day key a moment falls in — the same key `daily` rows are built with.
 *
 * Everything in this file buckets by UTC, so a caller asking "what did today cost" has to ask in the
 * same calendar the answer was computed in.
 */
export function usageDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Today's cost, read out of a report that already covers today.
 *
 * The deck used to get this by running a SECOND full usage scan bounded to midnight — every 45s, and
 * again on every window focus, over a store that reached 4.35 GB on the machine this was reported
 * from. The scan it already did contains the answer: `daily` is bucketed by day and its `cost` is
 * summed exactly the way a since-midnight scan's `globalCost` would be (per model, then per provider,
 * null only when nothing priceable was found). So the second scan was computing a number the first
 * one already had.
 */
export function todayCost(daily: readonly LocalDailyUsage[], nowMs: number): number | null {
  const key = usageDayKey(nowMs);
  return daily.find((row) => row.day === key)?.cost ?? null;
}
