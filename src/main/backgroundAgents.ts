// src/main/backgroundAgents.ts
// Read Claude Code's background sessions from `claude agents --json --all` (~200 ms; cached briefly,
// since the sidebar asks every 30 s and a paired machine may ask too).
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isBackgroundAgentId, parseBackgroundAgents, type BackgroundAgent } from '../shared/backgroundAgents';
import { cliInvocation, killChildTree } from './aiSummary';
import { resolveAgentCliPath } from './cliExecutable';

const CACHE_MS = 15_000;
const TIMEOUT_MS = 10_000;
/** With the records unchanged, the last answer is reused this long before the listing runs anyway. */
const UNCHANGED_RELIST_MS = 5 * 60_000;
/** Claude Code keeps one folder per background session here (its `state.json` inside); `claude rm` deletes it. */
const JOBS_DIR = join(homedir(), '.claude', 'jobs');
let cached: { at: number; listedAt: number; list: BackgroundAgent[]; records: string | null } | null = null;
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

/**
 * The background sessions, as `claude agents --json --all` lists them — but that command is a
 * Claude Code process (~340 ms, a 300 MB executable) started every poll, here and on every paired
 * PC, almost always to answer what it answered last time. It reads the job records under
 * `~/.claude/jobs`, so those are looked at first (a readdir and a stat per record, about a
 * millisecond): no records means no sessions and no process; records unchanged since the last
 * listing means the last answer, for up to five minutes; only a change runs the command.
 */
export async function listBackgroundAgents(nowMs = Date.now(), opts: { jobsDir?: string } = {}): Promise<BackgroundAgent[]> {
  if (paused) return cached?.list ?? [];
  if (cached && nowMs - cached.at < CACHE_MS) return cached.list;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const records = await jobRecordsSignature(opts.jobsDir ?? JOBS_DIR);
    if (records === '') return { list: [], records, listedAt: nowMs };
    if (cached && records !== null && cached.records === records && nowMs - cached.listedAt < UNCHANGED_RELIST_MS) {
      return { list: cached.list, records, listedAt: cached.listedAt };
    }
    const list = await run().then((json) => parseBackgroundAgents(json, Date.now())).catch(() => [] as BackgroundAgent[]);
    return { list, records, listedAt: Date.now() };
  })()
    .then(({ list, records, listedAt }) => { cached = { at: Date.now(), listedAt, list, records }; return list; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * What the listing would be reading: the session folders under the jobs dir and when each one's
 * `state.json` last changed. '' when there are none (or no such dir); null when it could not be read,
 * in which case the command runs as before.
 */
export async function jobRecordsSignature(dir: string): Promise<string | null> {
  let names: string[];
  try { names = await readdir(dir); } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null; }
  const parts = await Promise.all(names.filter((name) => isBackgroundAgentId(name)).map(async (name) => {
    try { const s = await stat(join(dir, name, 'state.json')); return `${name}:${Math.round(s.mtimeMs)}:${s.size}`; }
    catch { return `${name}:-`; }
  }));
  return parts.sort().join('|');
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

export type BackgroundCloseResult =
  | { ok: true; serviceStarted?: boolean }
  | { ok: false; error: 'bad-id' | 'not-listed' | 'failed'; detail?: string };

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
 * Both commands talk to Claude Code's background service (its on-demand daemon). When it is not
 * running — the usual state: it exits 50 s after its last client, and a Claude Code update leaves
 * none behind — `stop` and `rm` can answer "couldn't remove <id> — the background service may be
 * restarting. Try again in a moment." without starting one (seen on Claude Code 2.1.312, on this
 * PC and on a paired one). Trying again in a moment does not help; opening `claude agents` once
 * does, because that starts the service. So when `rm` refuses, DevDeck starts the service the way
 * Claude Code itself does (`claude daemon run --origin transient`, which exits again on its own
 * once idle) and runs the two commands once more.
 *
 * Only an id the listing currently shows is acted on: the id is the one thing put on the command
 * line, and this keeps a remote deck from naming sessions it was never shown.
 */
export async function closeBackgroundAgent(id: unknown, listed: readonly BackgroundAgent[], opts: { serviceWaitMs?: number } = {}): Promise<BackgroundCloseResult> {
  if (!isBackgroundAgentId(id)) return { ok: false, error: 'bad-id' };
  if (!listed.some((b) => b.id === id)) return { ok: false, error: 'not-listed' };
  let refusal = await stopAndRemove(id);
  let serviceStarted = false;
  if (refusal !== null && await startBackgroundService(opts.serviceWaitMs)) {
    serviceStarted = true;
    refusal = await stopAndRemove(id);
  }
  cached = null; // the next listing must show it gone (or still there, if rm refused)
  if (refusal !== null) return { ok: false, error: 'failed', detail: refusal };
  return serviceStarted ? { ok: true, serviceStarted } : { ok: true };
}

/** `claude stop` then `claude rm`; null once the session is gone, else what `rm` answered. */
async function stopAndRemove(id: string): Promise<string | null> {
  await runClaude(['stop', id], CLOSE_TIMEOUT_MS).catch(() => ''); // already exited → nothing to stop
  return runClaude(['rm', id], CLOSE_TIMEOUT_MS).then(
    () => null,
    // Listed a moment ago and gone now: that is the outcome asked for.
    (e: Error) => (/no job matching/i.test(e.message) ? null : e.message),
  );
}

/**
 * Start Claude Code's background service as Claude Code does on demand, and wait until `claude
 * daemon status` sees it (about a second; a few more on a busy PC). The transient service ends
 * itself 50 s after its last client, so nothing is left running for DevDeck to clean up. False
 * when it did not come up in time — the close is then reported as refused, with the reason.
 */
async function startBackgroundService(waitMs = SERVICE_WAIT_MS): Promise<boolean> {
  const how = cliInvocation(resolveAgentCliPath('claude'), ['daemon', 'run', '--origin', 'transient']);
  try {
    const child = spawn(how.file, how.args, { cwd: homedir(), env: claudeEnv(), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await runClaude(['daemon', 'status'], SERVICE_STATUS_TIMEOUT_MS).then(() => true, () => false)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(SERVICE_POLL_MS, left)));
  }
}

const CLOSE_TIMEOUT_MS = 20_000;
const SERVICE_WAIT_MS = 10_000;
const SERVICE_POLL_MS = 500;
const SERVICE_STATUS_TIMEOUT_MS = 5_000;

/** This process's environment without Claude Code's own session variables. */
function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A DevDeck started from inside Claude Code must not make this look like a nested session.
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  return env;
}

/**
 * Run `claude <args>` detached from this session's own Claude environment; resolves to stdout on
 * exit 0. On any other exit the error carries what the command said on stderr — that is where
 * `rm` explains a refusal, and the diagnostics log is where it has to end up.
 */
function runClaude(args: string[], timeoutMs: number, started?: (child: ChildProcess) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const how = cliInvocation(resolveAgentCliPath('claude'), args);
    const child = spawn(how.file, how.args, { cwd: homedir(), env: claudeEnv(), windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { killChildTree(child); reject(new Error(`claude ${args[0]} timed out`)); }, timeoutMs);
    started?.(child);
    child.on('close', () => { if (current === child) current = null; });
    child.stdout?.on('data', (b: Buffer) => { if (out.length < 2_000_000) out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { if (err.length < 4_000) err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude ${args[0]} exited ${code}${err.trim() ? `: ${err.trim().replace(/\s+/g, ' ').slice(0, 300)}` : ''}`));
    });
  });
}
