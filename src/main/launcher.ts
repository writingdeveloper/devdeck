import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
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
const execFileAsync = promisify(execFile);

/** Async PATH probe (never blocks the main process, unlike whichProbe's execFileSync). */
export type CliProbe = (cmd: string) => boolean | Promise<boolean>;
const defaultCliProbe: CliProbe = async (cmd) => {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * Warn-only guard for the agent CLI a terminal is about to run. DevDeck never resolves the
 * binary itself (the shell does), so a missing CLI otherwise surfaces only as the shell's raw
 * "command not recognized" — confusing on a fresh machine that never installed Claude Code.
 * Resolves to an actionable message when the command's binary is not on PATH, else null.
 * Warn-only by design: a PATH probe can't see shell-profile aliases/functions, so the terminal
 * still opens either way and the shell stays the source of truth. Only FOUND binaries are
 * cached — a miss re-probes, so installing the CLI mid-session clears the warning without a
 * restart (the toast tells the user to reopen the session, and that must be enough).
 */
export function makeCliGuard(exists: CliProbe = defaultCliProbe): (command: string) => Promise<string | null> {
  const found = new Set<string>();
  return async (command) => {
    const bin = command.trim().split(/\s+/)[0] ?? '';
    if (!bin || found.has(bin)) return null;
    if (await exists(bin)) { found.add(bin); return null; }
    const hint = bin === 'claude'
      ? ' Install Claude Code first: npm install -g @anthropic-ai/claude-code (see https://claude.com/claude-code), then reopen the session.'
      : ' Install it or check your PATH, then reopen the session.';
    return `The '${bin}' CLI was not found on PATH — the terminal will show a command-not-found error.${hint}`;
  };
}

/** Absolute path to a PowerShell executable for node-pty (which needs a resolvable path, unlike child_process). Windows-targeted.
 * Memoized: the result is constant for the process lifetime, and the sync `where` spawn otherwise stalls the main process on every cockpit open. */
let cachedShellPath: string | null = null;
export function resolveShellPath(): string {
  if (cachedShellPath) return cachedShellPath;
  try {
    const found = execFileSync('where', ['pwsh'], { windowsHide: true }).toString().trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return (cachedShellPath = found);
  } catch { /* pwsh not on PATH — fall back to Windows PowerShell */ }
  return (cachedShellPath = pathWin32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

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

export interface EditorSpec { command: string; args: string[]; shell: boolean; }

/**
 * How to launch VS Code at a directory. On POSIX `code` is a plain script — pass the
 * dir as an args-array entry (no shell = injection-safe). On Windows `code` is
 * `code.cmd`, which Node can only run through a shell, so quote the path (Windows
 * paths cannot contain `"`, so the quoting is safe).
 */
export function editorSpec(dir: string, platform: NodeJS.Platform = process.platform): EditorSpec {
  if (platform === 'win32') return { command: `code "${dir}"`, args: [], shell: true };
  return { command: 'code', args: [dir], shell: false };
}

export interface EditorOptions {
  platform?: NodeJS.Platform;
  spawnFn?: (command: string, args: string[], shell: boolean) => void;
  onError?: (msg: string) => void;
}

/** Open a directory in VS Code (`code <dir>`). */
export function openInEditor(dir: string, opts: EditorOptions = {}): void {
  const spec = editorSpec(dir, opts.platform ?? process.platform);
  if (opts.spawnFn) { opts.spawnFn(spec.command, spec.args, spec.shell); return; }
  const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', shell: spec.shell, windowsHide: false });
  child.on('error', (err) => {
    console.error('DevDeck: failed to open editor', err);
    opts.onError?.(`Failed to open editor (is the \`code\` CLI on your PATH?): ${(err as Error).message}`);
  });
  child.unref();
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
