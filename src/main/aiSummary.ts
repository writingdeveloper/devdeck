import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanSummaryText, SUMMARY_MAX } from '../shared/sessionSummary';

/**
 * Optional AI layer for the cockpit's per-session summary line.
 *
 * The free heuristics (shared/sessionSummary.ts) answer "what is this session doing" correctly maybe
 * half the time — a finished turn often opens with "모두 처리했습니다", which says nothing. When the
 * user turns this on, each finished turn is handed to `claude -p --model haiku` and the one-liner it
 * returns replaces the heuristic.
 *
 * Cost control, in order of importance:
 *  - the renderer only asks while a session is NOT working (i.e. once per finished turn, not per tick),
 *  - a per-session cooldown throttles chatty sessions,
 *  - results are cached by the session log's mtime, so re-asking an unchanged session costs nothing,
 *  - failures are cached too, so a broken CLI can't turn into a retry loop.
 *
 * `get()` is synchronous and returns whatever is cached right now (null on a miss) while queueing the
 * generation in the background — the sidebar picks the result up on its next refresh.
 */

export type RunSummary = (input: string) => Promise<string>;

/** Minimum gap between two AI calls for the SAME session, however often its log changes. */
export const AI_COOLDOWN_MS = 90_000;
/** A CLI start-up plus a haiku turn measured ~7-9s; well past that means something is wrong. */
export const AI_TIMEOUT_MS = 45_000;
const MAX_CACHE = 200;
const SOURCE_CAP = 1200;

interface Entry { mtimeMs: number; text: string | null; at: number }

export interface AiSummarizer {
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /**
   * The AI line for this session at this log mtime, or null when there isn't one yet.
   * Queues a generation on a miss (unless disabled, cooling down, or the source is empty).
   * `queue: false` reads the cache only — for callers that just want to render what exists
   * (e.g. while the session is mid-turn and a fresh summary would be premature).
   */
  get(sessionId: string, logMtimeMs: number, source: string, queue?: boolean): string | null;
  /** Resolves once the queue has drained — for tests and shutdown. */
  idle(): Promise<void>;
}

/** The instruction wrapped around a session's recent activity. Pure, so its shape is testable. */
export function buildSummaryPrompt(source: string): string {
  return [
    'You are labeling a coding-agent session in a dashboard sidebar.',
    'Read the recent activity below and answer ONLY with a short noun phrase naming what the session is working on.',
    'Rules: at most 24 characters, no punctuation at the end, no markdown, no greeting, no explanation.',
    'Answer in the same language as the activity. Never invent anything that is not in the text.',
    '--- recent activity ---',
    source.slice(0, SOURCE_CAP),
  ].join('\n');
}

/** First non-empty line of the model's answer, stripped of markdown and capped. */
export function normalizeAiSummary(raw: string): string {
  const line = String(raw ?? '').split('\n').map((l) => cleanSummaryText(l)).find((l) => l.length > 0) ?? '';
  return line.length > SUMMARY_MAX ? line.slice(0, SUMMARY_MAX - 1) + '…' : line;
}

/**
 * Production runner: `claude -p --model haiku` in a throwaway empty cwd.
 * - The prompt goes in on STDIN, never as an argv element: on Windows the CLI is a `.cmd` shim, which
 *   needs `shell: true`, and session text on a shell command line would be a command-injection hole.
 *   Every argv entry here is a fixed literal.
 * - The empty cwd + disabled MCP keep it from loading the project's CLAUDE.md/memory (measured 12.5s →
 *   ~8s, and it stops the model from "summarizing" things that aren't in the text).
 * - CLAUDECODE/CLAUDE_CODE_* are scrubbed so a DevDeck session launched from inside Claude Code
 *   doesn't make the child think it's nested.
 */
export function spawnClaudeSummary(input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    const child = spawn(
      'claude',
      ['-p', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
      { cwd, env, windowsHide: true, shell: process.platform === 'win32' },
    );
    let out = '';
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => done(() => { child.kill(); reject(new Error('summary timeout')); }), AI_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => { if (out.length < 4000) out += b.toString('utf8'); });
    child.stderr.on('data', () => { /* the CLI chats on stderr; the exit code is what matters */ });
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`)))));
    child.stdin.on('error', () => { /* closed early — the close handler reports it */ });
    child.stdin.end(input, 'utf8');
  });
}

/** Lazily created throwaway cwd (see spawnClaudeSummary). */
let scratchCwd: string | null = null;
function summaryCwd(): string {
  if (!scratchCwd) scratchCwd = mkdtempSync(join(tmpdir(), 'devdeck-sum-'));
  return scratchCwd;
}

export function makeAiSummarizer(deps: { run?: RunSummary; now?: () => number; cooldownMs?: number } = {}): AiSummarizer {
  const run = deps.run ?? ((input: string) => spawnClaudeSummary(input, summaryCwd()));
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? AI_COOLDOWN_MS;
  const cache = new Map<string, Entry>();
  const pending = new Map<string, { mtimeMs: number; source: string }>(); // one slot per session: newest wins
  let enabled = false;
  let draining: Promise<void> | null = null;

  const remember = (sessionId: string, entry: Entry): void => {
    cache.delete(sessionId);
    cache.set(sessionId, entry);
    if (cache.size > MAX_CACHE) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
  };

  // Strictly serial: several sessions finishing at once must not spawn several CLIs at once.
  const drain = async (): Promise<void> => {
    while (pending.size > 0) {
      const [sessionId, job] = pending.entries().next().value as [string, { mtimeMs: number; source: string }];
      pending.delete(sessionId);
      if (!enabled) continue; // turned off while queued
      let text: string | null = null;
      try {
        text = normalizeAiSummary(await run(buildSummaryPrompt(job.source))) || null;
      } catch {
        text = null; // cached as a miss so a broken CLI doesn't retry every tick
      }
      remember(sessionId, { mtimeMs: job.mtimeMs, text, at: now() });
    }
    draining = null;
  };

  // Start draining on the next microtask, never inside get(): a caller that queues a job and then
  // switches the feature off in the same tick must not have already spawned a CLI.
  const kick = (): void => { if (!draining) draining = Promise.resolve().then(drain); };

  return {
    setEnabled(on: boolean) {
      enabled = on === true;
      if (!enabled) pending.clear();
    },
    isEnabled: () => enabled,
    get(sessionId: string, logMtimeMs: number, source: string, queue = true): string | null {
      if (!enabled || !sessionId) return null;
      const hit = cache.get(sessionId);
      if (hit && hit.mtimeMs === logMtimeMs) return hit.text;
      const text = queue ? source.trim() : '';
      if (text) {
        const cooling = hit != null && now() - hit.at < cooldownMs;
        if (!cooling) { pending.set(sessionId, { mtimeMs: logMtimeMs, source: text }); kick(); }
      }
      // Show the previous line while the new one is generated — better than blanking the row mid-turn.
      return hit?.text ?? null;
    },
    async idle() { while (draining) await draining; },
  };
}
