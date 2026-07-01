import type { UsageTotals } from './usage';
import type { Todo } from './tasks';

export type AgentId = 'claude' | 'antigravity';

export type Language = 'ko' | 'en' | 'ja' | 'zh';

export interface Folder {
  path: string;
  kind: 'root' | 'repo';
}

export interface ModelUsage { model: string; totals: UsageTotals; costEstimate: number | null; }
export interface ProjectUsage {
  path: string; name: string; sessions: number;
  totals: UsageTotals; costEstimate: number | null; hasUnknownModel: boolean;
  /** Active working time (sum of message gaps within the idle cap), in ms. */
  activeMs: number;
  /** 'deleted' = the project folder is gone, but its Claude usage still lives in ~/.claude. */
  status: 'active' | 'deleted';
}
export interface UsageReport {
  global: UsageTotals; globalCost: number | null; hasUnknownModel: boolean;
  webSearch: number; webFetch: number; sessions: number;
  /** Total active working time across all scanned sessions, in ms. */
  activeMs: number;
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
  /** Browsable GitHub URL from `remote.origin.url`, or null when not a github.com repo. */
  repoUrl: string | null;
}

export interface StoreEntry {
  note: string;
  pinned: boolean;
  hidden: boolean;
  lastOpened: string | null; // ISO timestamp
  todos: Todo[];
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
  /** Browsable GitHub URL, or null when the repo has no github.com remote. */
  repoUrl: string | null;
  todos: Todo[];
}
