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
  // Only the production lookup is remembered; an injected env / exists is a test asking a question.
  const cacheable = env === process.env && exists === existsSync;
  const key = `${providerId}\n${env.PATH ?? env.Path ?? ''}`;
  if (cacheable) {
    const hit = _found.get(key);
    if (hit && Date.now() - hit.at < FOUND_TTL_MS && exists(hit.path)) return hit.path;
  }
  const found = lookUp(providerId, env, exists);
  if (cacheable && found !== providerId) _found.set(key, { path: found, at: Date.now() });
  return found;
}

function lookUp(providerId: LoginProvider, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  try {
    const found = execFileSync('where', [providerId], { env, windowsHide: true })
      .toString().split(/\r?\n/).map((line) => line.trim()).find((line) => /\.(?:cmd|exe)$/i.test(line) && exists(line));
    if (found) return found;
  } catch { /* stale/missing PATH — check stable per-user locations below */ }
  return knownWindowsCandidates(providerId, env).find(exists) ?? providerId;
}

/**
 * Paths already found, briefly. `where` is a synchronous child process — ~50 ms here during which the
 * main process does nothing else — and the Codex usage refresh ran it on every poll. Positive results
 * only (a CLI installed after DevDeck started must still be found on the next ask), re-checked for
 * existence on every hit (an uninstall is noticed at once), keyed by PATH (a changed PATH is a new
 * question), and expired after a few minutes so a different install that now comes first on PATH is
 * picked up without a restart.
 */
const FOUND_TTL_MS = 5 * 60_000;
const _found = new Map<string, { path: string; at: number }>();
/** Test-only: forget remembered CLI paths. */
export function _clearCliPathCache(): void { _found.clear(); }

/** Fixed, provider-owned login command for the visible PowerShell setup terminal. */
export function loginPowerShellCommand(providerId: LoginProvider): string {
  const executable = resolveAgentCliPath(providerId).replace(/'/g, "''");
  const args = providerId === 'codex' ? 'login' : 'auth login';
  return `& '${executable}' ${args}`;
}

