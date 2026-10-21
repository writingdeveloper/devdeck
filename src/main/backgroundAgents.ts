// src/main/backgroundAgents.ts
// Read Claude Code's background sessions from `claude agents --json --all` (~200 ms; cached briefly,
// since the sidebar asks every 30 s and a paired machine may ask too).
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { parseBackgroundAgents, type BackgroundAgent } from '../shared/backgroundAgents';
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
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // A DevDeck started from inside Claude Code must not make this look like a nested session.
    for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
    const how = cliInvocation(resolveAgentCliPath('claude'), ['agents', '--json', '--all']);
    const child = spawn(how.file, how.args, { cwd: homedir(), env, windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { killChildTree(child); reject(new Error('claude agents timed out')); }, TIMEOUT_MS);
    current = child;
    child.on('close', () => { if (current === child) current = null; });
    child.stdout.on('data', (b: Buffer) => { if (out.length < 2_000_000) out += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`claude agents exited ${code}`)); });
  });
}
