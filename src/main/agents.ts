import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentId, SessionMeta } from '../shared/types';
import { listSessions, listSessionIds, lastUserMessageForSession } from './sessions';
import { listAntigravitySessions, listAntigravitySessionIds, lastUserMessageForAntigravitySession, antigravityAvailable } from './antigravitySessions';
import { SESSION_ID_RE } from '../shared/paths';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const ANTIGRAVITY_DIR = join(homedir(), '.gemini', 'antigravity');

export type LaunchKind = 'new' | 'continue' | 'resume';

export interface AgentProvider {
  id: AgentId;
  label: string;
  supportsSessionId: boolean;
  isAvailable(): boolean;
  // Async: the deck scans sessions for EVERY project every ~45s + on focus — sync file I/O here blocked
  // the main process (and thus live cockpit PTY output / IPC). listSessionIds stays sync (single project).
  listSessions(projectPath: string, limit?: number): Promise<SessionMeta[]>;
  listSessionIds(projectPath: string): string[]; // ALL on-disk ids, mtime-desc (for the restore resolver)
  lastUserMessage(projectPath: string, sessionId: string): Promise<string | null>;
  buildCommand(kind: LaunchKind, sessionId?: string): string;
}

const claudeProvider: AgentProvider = {
  id: 'claude',
  label: 'Claude',
  supportsSessionId: true,
  isAvailable: () => existsSync(CLAUDE_PROJECTS),
  listSessions: (p, limit) => listSessions(p, CLAUDE_PROJECTS, limit),
  listSessionIds: (p) => listSessionIds(p, CLAUDE_PROJECTS),
  lastUserMessage: (p, id) => lastUserMessageForSession(p, id, CLAUDE_PROJECTS),
  // ^ listSessions / lastUserMessage are async (fs/promises) — see AgentProvider.
  buildCommand: (kind, id) => {
    if (kind === 'resume' && id && SESSION_ID_RE.test(id)) return `claude --resume ${id}`;
    if (kind === 'new' && id && SESSION_ID_RE.test(id)) return `claude --session-id ${id}`;
    return kind === 'new' ? 'claude' : 'claude -c';
  },
};

const antigravityProvider: AgentProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  supportsSessionId: false, // agy has no --session-id pin; --conversation resumes by id only
  isAvailable: () => antigravityAvailable(ANTIGRAVITY_DIR),
  // Async to match the interface; antigravity's own reads stay sync (rare provider, small .db files).
  listSessions: async (p, limit) => listAntigravitySessions(p, ANTIGRAVITY_DIR, limit),
  listSessionIds: (p) => listAntigravitySessionIds(p, ANTIGRAVITY_DIR),
  lastUserMessage: async (p, id) => lastUserMessageForAntigravitySession(p, id, ANTIGRAVITY_DIR),
  buildCommand: (kind, id) => {
    if (kind === 'resume' && id && SESSION_ID_RE.test(id)) return `agy --conversation ${id}`;
    return kind === 'new' ? 'agy' : 'agy -c';
  },
};

const PROVIDERS: Record<AgentId, AgentProvider> = { claude: claudeProvider, antigravity: antigravityProvider };

export function getProvider(id: AgentId): AgentProvider {
  return PROVIDERS[id] ?? claudeProvider;
}

/** Installed agents (claude always; antigravity if ~/.gemini/antigravity exists). `probe` overridable for tests. */
export function availableAgents(probe?: (id: AgentId) => boolean): AgentId[] {
  const ids: AgentId[] = ['claude', 'antigravity'];
  const isAvail = probe ?? ((id) => PROVIDERS[id].isAvailable());
  return ids.filter(isAvail);
}

export interface OpenResolution { command: string; sessionId: string | null; }

/**
 * Resolve BOTH the launch command and the concrete session id to persist for faithful restore.
 * - fresh / brand-new: a new conversation pinned to a uuid (`claude --session-id`) when supported.
 * - resume: the given id. - continue: the latest existing id (so restore is deterministic, not "latest").
 * Pure (no electron) so it's unit-testable in CI; `genId` injects a UUID generator.
 */
export function resolveOpenSession(
  a: AgentProvider,
  opts: { fresh: boolean; sessionId: string | null; sessionCount: number; latestId: string | null; genId: () => string },
): OpenResolution {
  if (opts.fresh || (opts.sessionId == null && opts.sessionCount === 0)) {
    if (a.supportsSessionId) { const id = opts.genId(); return { command: a.buildCommand('new', id), sessionId: id }; }
    return { command: a.buildCommand('new'), sessionId: null };
  }
  if (typeof opts.sessionId === 'string') return { command: a.buildCommand('resume', opts.sessionId), sessionId: opts.sessionId };
  return { command: a.buildCommand('continue'), sessionId: opts.latestId };
}
