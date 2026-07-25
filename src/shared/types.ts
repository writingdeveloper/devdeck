import type { UsageTotals } from './usage';
import type { Todo } from './tasks';

export type AgentId = 'claude' | 'antigravity' | 'codex';

/** Narrow an untrusted value (persisted state, IPC payload) to an AgentId; null when it isn't one.
 *  Session-scoped IPC uses this so a tile always acts through the provider that OWNS it — falling back
 *  to the globally selected agent only when the caller genuinely has no session context. */
export function toAgentId(v: unknown): AgentId | null {
  return v === 'claude' || v === 'antigravity' || v === 'codex' ? v : null;
}

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

/**
 * A project's session as the DECK sees it: the provider that OWNS it travels with it. The deck used to
 * read sessions through the single globally selected agent and label them with it, so flipping the
 * selection made every project's history read as that agent's — and opening one handed a Claude
 * conversation to `codex`. Sessions are aggregated across installed providers instead, each carrying
 * its owner so the mark shown and the agent launched are both the truth on disk.
 */
export interface ProjectSession extends SessionMeta {
  agentId: AgentId;
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
  sessions: ProjectSession[];
  sessionCount: number;
  /** Providers that have sessions here, ordered by their newest session (owner of `sessions[0]` first). */
  agentIds: AgentId[];
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
