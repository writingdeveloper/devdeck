import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanSummaryText, SUMMARY_MAX } from '../shared/sessionSummary';
import { codexExecFinalMessage } from '../shared/codexParse';
import type { AgentId } from '../shared/types';

/**
 * Optional AI layer for the cockpit's per-session summary line.
 *
 * The free heuristics (shared/sessionSummary.ts) answer "what is this session doing" correctly maybe
 * half the time — a finished turn often opens with "모두 처리했습니다", which says nothing. When the
 * user turns this on, each finished turn is handed to an agent CLI and the one-liner it returns
 * replaces the heuristic.
 *
 * A session is summarized by ITS OWN provider's CLI — a Claude session by `claude`, a Codex session by
 * `codex`. Routing everything through one vendor would be wrong for a tool that is deliberately
 * multi-provider: it would spend Claude quota on Codex work, and would leave anyone who installed only
 * Codex with a feature that silently never works.
 *
 * Cost control, in order of importance:
 *  - the renderer only asks while a session is NOT working (i.e. once per finished turn, not per tick),
 *  - a per-session cooldown throttles chatty sessions,
 *  - results are cached by the session log's mtime, so re-asking an unchanged session costs nothing,
 *  - failures are cached too, so a missing CLI can't turn into a retry loop.
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
   * Queues a generation on a miss (unless disabled, cooling down, the source is empty, or the
   * provider has no summarizer). `queue: false` reads the cache only — for callers that just want to
   * render what exists (e.g. while the session is mid-turn and a fresh summary would be premature).
   */
  get(sessionId: string, logMtimeMs: number, source: string, opts?: { queue?: boolean; provider?: AgentId }): string | null;
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
 * Run an agent CLI headlessly and return its stdout.
 *
 * The prompt goes in on STDIN, never as an argv element: on Windows these CLIs are `.cmd` shims, which
 * need `shell: true`, and session text on a shell command line would be a command-injection hole.
 * Every argv entry passed here is a fixed literal.
 */
function runCli(bin: string, args: string[], input: string, cwd: string, scrubEnv: (key: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (scrubEnv(k)) delete env[k];
    const child = spawn(bin, args, { cwd, env, windowsHide: true, shell: process.platform === 'win32' });
    let out = '';
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => done(() => { child.kill(); reject(new Error('summary timeout')); }), AI_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => { if (out.length < 32_000) out += b.toString('utf8'); });
    child.stderr.on('data', () => { /* the CLIs chat on stderr; the exit code is what matters */ });
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}`)))));
    child.stdin.on('error', () => { /* closed early — the close handler reports it */ });
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Claude runner: `claude -p --model haiku` in a throwaway empty cwd.
 * The empty cwd + disabled MCP keep it from loading the project's CLAUDE.md/memory (measured 12.5s →
 * ~8.8s, and it stops the model from "summarizing" things that aren't in the text). CLAUDECODE /
 * CLAUDE_CODE_* are scrubbed so a DevDeck launched from inside Claude Code doesn't make the child
 * think it is nested. Verified not to leave a session file behind.
 */
export function spawnClaudeSummary(input: string, cwd: string): Promise<string> {
  return runCli(
    'claude',
    ['-p', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    input, cwd,
    (k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'),
  );
}

/**
 * Codex runner: `codex exec --json` in a throwaway empty cwd (measured ~2.1s).
 * - `--ephemeral` is why this is safe to run behind the user's back: Codex would otherwise write a
 *   rollout for every summary, and those would show up in DevDeck's own session lists. Verified: the
 *   store stayed at 101 rollouts across runs.
 * - `--ignore-user-config` / `--ignore-rules` skip config.toml, MCP servers and project rules (auth
 *   still resolves through CODEX_HOME); `--skip-git-repo-check` is required because the cwd is an
 *   empty temp dir; `-s read-only` because summarizing never needs to write.
 * - `--json` gives structured events instead of decorated console output, so the answer is parsed,
 *   not scraped.
 */
export function spawnCodexSummary(input: string, cwd: string): Promise<string> {
  return runCli(
    'codex',
    ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '-'],
    input, cwd,
    () => false,
  ).then((out) => codexExecFinalMessage(out) ?? '');
}

/** Lazily created throwaway cwd (see spawnClaudeSummary). */
let scratchCwd: string | null = null;
function summaryCwd(): string {
  if (!scratchCwd) scratchCwd = mkdtempSync(join(tmpdir(), 'devdeck-sum-'));
  return scratchCwd;
}

/** Per-provider summarizers. Antigravity has none — its transcripts aren't readable this way. */
const DEFAULT_RUNNERS: Partial<Record<AgentId, RunSummary>> = {
  claude: (input) => spawnClaudeSummary(input, summaryCwd()),
  codex: (input) => spawnCodexSummary(input, summaryCwd()),
};

export function makeAiSummarizer(deps: { runners?: Partial<Record<AgentId, RunSummary>>; now?: () => number; cooldownMs?: number } = {}): AiSummarizer {
  const runners = deps.runners ?? DEFAULT_RUNNERS;
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? AI_COOLDOWN_MS;
  const cache = new Map<string, Entry>();
  const pending = new Map<string, { mtimeMs: number; source: string; provider: AgentId }>(); // one slot per session: newest wins
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
      const [sessionId, job] = pending.entries().next().value as [string, { mtimeMs: number; source: string; provider: AgentId }];
      pending.delete(sessionId);
      if (!enabled) continue; // turned off while queued
      const run = runners[job.provider];
      if (!run) continue; // no summarizer for this provider — the heuristic line stands
      let text: string | null = null;
      try {
        text = normalizeAiSummary(await run(buildSummaryPrompt(job.source))) || null;
      } catch {
        text = null; // cached as a miss so a missing CLI doesn't retry every tick
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
    get(sessionId: string, logMtimeMs: number, source: string, opts: { queue?: boolean; provider?: AgentId } = {}): string | null {
      if (!enabled || !sessionId) return null;
      const hit = cache.get(sessionId);
      if (hit && hit.mtimeMs === logMtimeMs) return hit.text;
      const provider = opts.provider ?? 'claude';
      const text = opts.queue !== false && runners[provider] ? source.trim() : '';
      if (text) {
        const cooling = hit != null && now() - hit.at < cooldownMs;
        if (!cooling) { pending.set(sessionId, { mtimeMs: logMtimeMs, source: text, provider }); kick(); }
      }
      // Show the previous line while the new one is generated — better than blanking the row mid-turn.
      return hit?.text ?? null;
    },
    async idle() { while (draining) await draining; },
  };
}
