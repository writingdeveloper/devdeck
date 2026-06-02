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
  badge: string; // e.g. "🟢 오늘", "🔴 9일"
}

export interface GitInfo {
  branch: string | null;
  lastCommitMs: number | null;
  lastSubject: string | null;
  uncommitted: number;
}

export interface StoreEntry {
  note: string;
  pinned: boolean;
  hidden: boolean;
  staleDays: number | null;
  lastOpened: string | null; // ISO timestamp
}

export interface ProjectViewModel {
  path: string;
  name: string;
  branch: string | null;
  uncommitted: number;
  lastCommitMs: number | null;
  lastSubject: string | null;
  lastSessionMs: number | null;
  activityMs: number | null; // max(lastCommitMs, lastSessionMs)
  stale: StaleInfo;
  note: string;
  pinned: boolean;
  hidden: boolean;
}
