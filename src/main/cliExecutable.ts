import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';
import type { AgentId } from '../shared/types';

type LoginProvider = Extract<AgentId, 'claude' | 'codex'>;

function knownWindowsCandidates(providerId: LoginProvider, env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  const profile = env.USERPROFILE;
  if (providerId === 'codex') return [
    ...(appData ? [pathWin32.join(appData, 'npm', 'codex.cmd')] : []),
    ...(localAppData ? [pathWin32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : []),
  ];
  return [
    ...(appData ? [pathWin32.join(appData, 'npm', 'claude.cmd')] : []),
    ...(profile ? [pathWin32.join(profile, '.local', 'bin', 'claude.exe')] : []),
    ...(localAppData ? [pathWin32.join(localAppData, 'Programs', 'Claude', 'claude.exe')] : []),
  ];
}

/**
 * Resolve the concrete CLI executable used by background adapters and setup terminals.
 * Known per-user install locations are checked even when DevDeck's long-lived tray process has an
 * older PATH than a terminal opened after installation.
 */
export function resolveAgentCliPath(
  providerId: LoginProvider,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') return providerId;
  try {
    const found = execFileSync('where', [providerId], { env, windowsHide: true })
      .toString().split(/\r?\n/).map((line) => line.trim()).find((line) => /\.(?:cmd|exe)$/i.test(line) && exists(line));
    if (found) return found;
  } catch { /* stale/missing PATH — check stable per-user locations below */ }
  return knownWindowsCandidates(providerId, env).find(exists) ?? providerId;
}

/** Fixed, provider-owned login command for the visible PowerShell setup terminal. */
export function loginPowerShellCommand(providerId: LoginProvider): string {
  const executable = resolveAgentCliPath(providerId).replace(/'/g, "''");
  const args = providerId === 'codex' ? 'login' : 'auth login';
  return `& '${executable}' ${args}`;
}

