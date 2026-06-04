import { spawn, execFileSync } from 'node:child_process';
import { win32 as pathWin32 } from 'node:path';
import { buildWtArgs, type WtTab } from '../shared/wtArgs';
import { buildMacLaunch, buildLinuxLaunch, type LaunchCmd } from '../shared/posixLaunch';

export type SpawnFn = (file: string, args: string[]) => void;
export type ExistsProbe = (cmd: string) => boolean;

/**
 * Path to Windows Terminal's WindowsApps execution alias.
 *
 * `wt.exe` is a reparse-point alias, not a normal file: `fs.existsSync` reports it
 * as missing and Node's PATH search for a bare `wt.exe` stat-rejects it, so
 * `spawn('wt.exe')` fails with ENOENT even when WindowsApps is on PATH. Spawning
 * the FULL alias path directly works — CreateProcess resolves the reparse point.
 */
export function resolveWtPath(localAppData = process.env.LOCALAPPDATA): string {
  // Always a Windows path (wt.exe is Windows-only), so use win32.join — plain
  // join() would emit POSIX separators when this runs/tests on macOS or Linux.
  return localAppData
    ? pathWin32.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')
    : 'wt.exe';
}

function whichProbe(probe: string): ExistsProbe {
  return (cmd) => {
    try {
      execFileSync(probe, [cmd], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
}
const defaultPwshExists = whichProbe('where');

/** Prefer PowerShell 7 (`pwsh`) if it is on PATH, else fall back to Windows PowerShell. */
export function resolveShell(exists: ExistsProbe = defaultPwshExists): string {
  return exists('pwsh') ? 'pwsh' : 'powershell';
}

/** Linux terminal emulators we know how to drive, in preference order. */
export const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'alacritty', 'kitty', 'xterm'];

/** First installed terminal from LINUX_TERMINALS, or null if none are found. */
export function detectLinuxTerminal(exists: ExistsProbe = whichProbe('which')): string | null {
  for (const t of LINUX_TERMINALS) if (exists(t)) return t;
  return null;
}

export interface PlanDeps {
  wtPath?: string;
  shell?: string;
  linuxTerm?: string | null;
}

/** Build the list of spawnable commands for the given platform (pure given its deps). */
export function planLaunch(tabs: WtTab[], platform: NodeJS.Platform, deps: PlanDeps = {}): LaunchCmd[] {
  if (tabs.length === 0) return [];
  if (platform === 'darwin') return buildMacLaunch(tabs);
  if (platform === 'linux') {
    const term = deps.linuxTerm ?? detectLinuxTerminal();
    return term ? buildLinuxLaunch(tabs, term) : [];
  }
  // win32 and anything else: one Windows Terminal window with a tab per project
  const wtPath = deps.wtPath ?? resolveWtPath();
  const shell = deps.shell ?? resolveShell();
  return [{ file: wtPath, args: buildWtArgs(tabs, shell) }];
}

export interface OpenOptions {
  platform?: NodeJS.Platform;
  wtPath?: string;
  shell?: string;
  linuxTerm?: string | null;
  spawnFn?: SpawnFn;
  onError?: (msg: string) => void;
}

function defaultSpawn(onError?: (msg: string) => void): SpawnFn {
  return (file, args) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => {
      console.error('DevDeck: failed to launch terminal', err);
      onError?.(`Failed to launch terminal (${file}): ${(err as Error).message}`);
    });
    child.unref();
  };
}

/** Open each project in a platform-appropriate terminal running its command. */
export function openProjects(tabs: WtTab[], opts: OpenOptions = {}): void {
  if (tabs.length === 0) return;
  const platform = opts.platform ?? process.platform;

  let linuxTerm = opts.linuxTerm;
  if (platform === 'linux' && linuxTerm === undefined) linuxTerm = detectLinuxTerminal();
  if (platform === 'linux' && !linuxTerm) {
    opts.onError?.('No supported terminal emulator found (tried ' + LINUX_TERMINALS.join(', ') + '). Install one.');
    return;
  }

  const cmds = planLaunch(tabs, platform, { wtPath: opts.wtPath, shell: opts.shell, linuxTerm });
  const doSpawn = opts.spawnFn ?? defaultSpawn(opts.onError);
  for (const c of cmds) doSpawn(c.file, c.args);
}
