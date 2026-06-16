import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentId, SessionMeta } from '../shared/types';
import { listSessions, lastUserMessageForSession } from './sessions';
import { listCodexSessions, lastUserMessageForCodexSession, codexAvailable } from './codexSessions';

const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

export type LaunchKind = 'new' | 'continue' | 'resume';

export interface AgentProvider {
  id: AgentId;
  label: string;
  supportsSessionId: boolean;
  isAvailable(): boolean;
  listSessions(projectPath: string, limit?: number): SessionMeta[];
  lastUserMessage(projectPath: string, sessionId: string): string | null;
  buildCommand(kind: LaunchKind, sessionId?: string): string;
}

const claudeProvider: AgentProvider = {
  id: 'claude',
  label: 'Claude',
  supportsSessionId: true,
  isAvailable: () => existsSync(CLAUDE_PROJECTS),
  listSessions: (p, limit) => listSessions(p, CLAUDE_PROJECTS, limit),
  lastUserMessage: (p, id) => lastUserMessageForSession(p, id, CLAUDE_PROJECTS),
  buildCommand: (kind, id) => {
    if (kind === 'resume' && id && SESSION_ID_RE.test(id)) return `claude --resume ${id}`;
    if (kind === 'new' && id && SESSION_ID_RE.test(id)) return `claude --session-id ${id}`;
    return kind === 'new' ? 'claude' : 'claude -c';
  },
};

const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
  supportsSessionId: false,
  isAvailable: () => codexAvailable(CODEX_SESSIONS),
  listSessions: (p, limit) => listCodexSessions(p, CODEX_SESSIONS, limit),
  lastUserMessage: (p, id) => lastUserMessageForCodexSession(p, id, CODEX_SESSIONS),
  buildCommand: (kind, id) => {
    if (kind === 'resume' && id && SESSION_ID_RE.test(id)) return `codex resume ${id}`;
    return kind === 'new' ? 'codex' : 'codex resume --last';
  },
};

const PROVIDERS: Record<AgentId, AgentProvider> = { claude: claudeProvider, codex: codexProvider };

export function getProvider(id: AgentId): AgentProvider {
  return PROVIDERS[id] ?? claudeProvider;
}

/** Installed agents (claude always; codex if ~/.codex/sessions exists). `probe` overridable for tests. */
export function availableAgents(probe?: (id: AgentId) => boolean): AgentId[] {
  const ids: AgentId[] = ['claude', 'codex'];
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
