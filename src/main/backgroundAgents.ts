// src/main/backgroundAgents.ts
// Read Claude Code's background sessions from `claude agents --json --all` (~200 ms; cached briefly,
// since the sidebar asks every 30 s and a paired machine may ask too).
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { isBackgroundAgentId, parseBackgroundAgents, type BackgroundAgent } from '../shared/backgroundAgents';
import { cliInvocation, killChildTree } from './aiSummary';
import { resolveAgentCliPath } from './cliExecutable';

const CACHE_MS = 15_000;
const TIMEOUT_MS = 10_000;
let cached: { at: number; list: BackgroundAgent[] } | null = null;
let inFlight: Promise<BackgroundAgent[]> | null = null;

let paused = false;
/**
 * Hold off starting `claude` while it is being updated: the update replaces the executable, and a
 * listing started meanwhile would hold it open. The last list is answered in the meantime.
 */
export async function pauseBackgroundAgents(on: boolean): Promise<void> {
  paused = on;
  if (on) await inFlight?.catch(() => undefined); // one already running finishes first
}

export async function listBackgroundAgents(nowMs = Date.now()): Promise<BackgroundAgent[]> {
  if (paused) return cached?.list ?? [];
  if (cached && nowMs - cached.at < CACHE_MS) return cached.list;
  if (inFlight) return inFlight;
  inFlight = run().then((json) => parseBackgroundAgents(json, Date.now())).catch(() => [] as BackgroundAgent[])
    .then((list) => { cached = { at: Date.now(), list }; return list; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function _clearBackgroundAgentCache(): void { cached = null; }

/** The listing child while one runs, so quitting can end it instead of orphaning it. */
let current: ChildProcess | null = null;

/** End a listing still running — on quit, before the process that started it goes away. */
export function stopBackgroundAgentListing(): void {
  if (current) killChildTree(current);
  current = null;
  paused = true;
}

function run(): Promise<string> {
  return runClaude(['agents', '--json', '--all'], TIMEOUT_MS, (child) => { current = child; });
}

export type BackgroundCloseResult = { ok: true } | { ok: false; error: 'bad-id' | 'not-listed' | 'failed' };

/**
 * Close one of Claude Code's background sessions: `claude stop <id>` (ends it if it is still running;
 * one that already exited refuses, which is fine), then `claude rm <id>` (takes it off the list and
 * deletes its job record). The conversation itself stays on disk and can still be resumed.
 *
 * Until now the sidebar listed these but offered nothing on them — a session that finished months ago
 * stayed under "Background" with no way to make it leave, short of the terminal. Verified on Windows
 * (Claude Code 2.1.311): `stop` prints "stopped <id>", `rm` prints "removed <id>" and the
 * `~/.claude/jobs/<id>` folder is gone.
 *
 * Only an id the listing currently shows is acted on: the id is the one thing put on the command
 * line, and this keeps a remote deck from naming sessions it was never shown.
 */
export async function closeBackgroundAgent(id: unknown, listed: readonly BackgroundAgent[]): Promise<BackgroundCloseResult> {
  if (!isBackgroundAgentId(id)) return { ok: false, error: 'bad-id' };
  if (!listed.some((b) => b.id === id)) return { ok: false, error: 'not-listed' };
  await runClaude(['stop', id], CLOSE_TIMEOUT_MS).catch(() => ''); // already exited → nothing to stop
  const removed = await runClaude(['rm', id], CLOSE_TIMEOUT_MS).then(() => true, () => false);
  cached = null; // the next listing must show it gone (or still there, if rm refused)
  return removed ? { ok: true } : { ok: false, error: 'failed' };
}

const CLOSE_TIMEOUT_MS = 20_000;

/** Run `claude <args>` detached from this session's own Claude environment; resolves to stdout on exit 0. */
function runClaude(args: string[], timeoutMs: number, started?: (child: ChildProcess) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // A DevDeck started from inside Claude Code must not make this look like a nested session.
    for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
    const how = cliInvocation(resolveAgentCliPath('claude'), args);
    const child = spawn(how.file, how.args, { cwd: homedir(), env, windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { killChildTree(child); reject(new Error(`claude ${args[0]} timed out`)); }, timeoutMs);
    started?.(child);
    child.on('close', () => { if (current === child) current = null; });
    child.stdout.on('data', (b: Buffer) => { if (out.length < 2_000_000) out += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`claude ${args[0]} exited ${code}`)); });
  });
}
