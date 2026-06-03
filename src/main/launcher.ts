import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildWtArgs, type WtTab } from '../shared/wtArgs';

export type SpawnFn = (file: string, args: string[]) => void;

export interface OpenOptions {
  wtPath: string;
  shell: string;
  spawnFn?: SpawnFn;
}

/**
 * Path to Windows Terminal's WindowsApps execution alias.
 *
 * `wt.exe` is a reparse-point alias, not a normal file: `fs.existsSync` reports it
 * as missing and Node's PATH search for a bare `wt.exe` stat-rejects it, so
 * `spawn('wt.exe')` fails with ENOENT even when WindowsApps is on PATH. Spawning
 * the FULL alias path directly works — CreateProcess resolves the reparse point —
 * so we always return the full path (never gate it on existsSync) and fall back to
 * the bare name only when LOCALAPPDATA is unavailable.
 */
export function resolveWtPath(localAppData = process.env.LOCALAPPDATA): string {
  return localAppData
    ? join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')
    : 'wt.exe';
}

const defaultSpawn: SpawnFn = (file, args) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => console.error('DevDeck: failed to launch Windows Terminal', err));
  child.unref();
};

export type ExistsProbe = (cmd: string) => boolean;

const defaultPwshExists: ExistsProbe = (cmd) => {
  try {
    execFileSync('where', [cmd], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/** Prefer PowerShell 7 (`pwsh`) if it is on PATH, else fall back to Windows PowerShell. */
export function resolveShell(exists: ExistsProbe = defaultPwshExists): string {
  return exists('pwsh') ? 'pwsh' : 'powershell';
}

export function openProjects(
  tabs: WtTab[],
  opts: OpenOptions & { onError?: (msg: string) => void },
): void {
  if (tabs.length === 0) return;
  const args = buildWtArgs(tabs, opts.shell);
  if (opts.spawnFn) { opts.spawnFn(opts.wtPath, args); return; }
  const child = spawn(opts.wtPath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => {
    console.error('DevDeck: failed to launch Windows Terminal', err);
    opts.onError?.(`Windows Terminal 실행 실패: ${(err as Error).message}`);
  });
  child.unref();
}
