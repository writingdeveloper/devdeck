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
  isAvailable(): boolean;
  listSessions(projectPath: string, limit?: number): SessionMeta[];
  lastUserMessage(projectPath: string, sessionId: string): string | null;
  buildCommand(kind: LaunchKind, sessionId?: string): string;
}

const claudeProvider: AgentProvider = {
  id: 'claude',
  label: 'Claude',
  isAvailable: () => existsSync(CLAUDE_PROJECTS),
  listSessions: (p, limit) => listSessions(p, CLAUDE_PROJECTS, limit),
  lastUserMessage: (p, id) => lastUserMessageForSession(p, id, CLAUDE_PROJECTS),
  buildCommand: (kind, id) => {
    if (kind === 'resume' && id && SESSION_ID_RE.test(id)) return `claude -r ${id}`;
    return kind === 'new' ? 'claude' : 'claude -c';
  },
};

const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
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

/** Pick the agent command for a cockpit/terminal open: resume > continue > new. (Pure — no electron, so it's unit-testable in CI where the electron binary is skipped.) */
export function resolveOpenCommand(
  a: AgentProvider, sessionId: string | null, sessionCount: (p?: string) => number,
): string {
  if (typeof sessionId === 'string') return a.buildCommand('resume', sessionId);
  return a.buildCommand(sessionCount() > 0 ? 'continue' : 'new');
}
