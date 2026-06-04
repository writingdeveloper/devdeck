import type { UsageTotals } from './usage';

export type Language = 'ko' | 'en' | 'ja' | 'zh';

export interface ModelUsage { model: string; totals: UsageTotals; costEstimate: number | null; }
export interface ProjectUsage {
  path: string; name: string; sessions: number;
  totals: UsageTotals; costEstimate: number | null; hasUnknownModel: boolean;
}
export interface UsageReport {
  global: UsageTotals; globalCost: number | null; hasUnknownModel: boolean;
  webSearch: number; webFetch: number; sessions: number;
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  daily: { day: string; cost: number | null; tokens: number }[];
}

export type StaleLevel = 'fresh' | 'neutral' | 'warn' | 'neglected';

export interface StaleThresholds {
  /** age < freshDays  -> fresh */
  freshDays: number;
  /** age < warnDays   -> neutral */
  warnDays: number;
  /** age < neglectedDays -> warn; otherwise neglected */
  neglectedDays: number;
}

export interface StaleInfo {
  level: StaleLevel;
  ageDays: number | null;
}

export interface SessionMeta {
  id: string;
  mtimeMs: number;
  firstMessage: string | null;
}

export interface GitInfo {
  branch: string | null;
  lastCommitMs: number | null;
  lastSubject: string | null;
  uncommitted: number;
  /** Commits ahead of the upstream branch (unpushed); null when there is no upstream. */
  ahead: number | null;
}

export interface StoreEntry {
  note: string;
  pinned: boolean;
  hidden: boolean;
  lastOpened: string | null; // ISO timestamp
}

export interface ResumeCue {
  kind: 'lastMessage'; // 'todos' reserved for future structured harvesting
  text: string;
}

export interface ProjectViewModel {
  path: string;
  name: string;
  branch: string | null;
  uncommitted: number;
  ahead: number | null;
  lastCommitMs: number | null;
  lastSubject: string | null;
  lastSessionMs: number | null;
  sessions: SessionMeta[];
  sessionCount: number;
  activityMs: number | null; // max(lastCommitMs, lastSessionMs)
  stale: StaleInfo;
  note: string;
  pinned: boolean;
  hidden: boolean;
  lastOpened: string | null;
  resumeCue: ResumeCue | null;
}
