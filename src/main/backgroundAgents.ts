// src/main/backgroundAgents.ts
// Read Claude Code's background sessions from `claude agents --json --all` (~200 ms; cached briefly,
// since the sidebar asks every 30 s and a paired machine may ask too).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { parseBackgroundAgents, type BackgroundAgent } from '../shared/backgroundAgents';
import { cliInvocation, killChildTree } from './aiSummary';
import { resolveAgentCliPath } from './cliExecutable';

const CACHE_MS = 15_000;
const TIMEOUT_MS = 10_000;
let cached: { at: number; list: BackgroundAgent[] } | null = null;
let inFlight: Promise<BackgroundAgent[]> | null = null;

export async function listBackgroundAgents(nowMs = Date.now()): Promise<BackgroundAgent[]> {
  if (cached && nowMs - cached.at < CACHE_MS) return cached.list;
  if (inFlight) return inFlight;
  inFlight = run().then((json) => parseBackgroundAgents(json, Date.now())).catch(() => [] as BackgroundAgent[])
    .then((list) => { cached = { at: Date.now(), list }; return list; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function _clearBackgroundAgentCache(): void { cached = null; }

function run(): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // A DevDeck started from inside Claude Code must not make this look like a nested session.
    for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
    const how = cliInvocation(resolveAgentCliPath('claude'), ['agents', '--json', '--all']);
    const child = spawn(how.file, how.args, { cwd: homedir(), env, windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { killChildTree(child); reject(new Error('claude agents timed out')); }, TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => { if (out.length < 2_000_000) out += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`claude agents exited ${code}`)); });
  });
}
