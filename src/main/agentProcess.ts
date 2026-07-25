// src/main/agentProcess.ts
// WHICH agent is actually running inside a cockpit tile, read from the OS process tree.
//
// A tile's provider used to be decided once, at launch, and never re-checked. But the pty is a real
// shell (`pwsh -NoExit -Command "<agent>"`): when the agent exits, the prompt stays, and the user can
// type ANOTHER agent into the same tile — `codex resume …` finishes, they run `claude`. The tile then
// kept saying Codex forever: its mark, its session-id drift probe, its model/context read and the
// usage footer all attributed a live Claude Code conversation to Codex.
//
// Disk evidence can't settle this (a session file for the same project may belong to an external
// terminal), but the process tree can: whatever agent binary is a descendant of THIS tile's shell is
// what the user is talking to. One process listing per probe window is shared by every tile.
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { AgentId } from '../shared/types';

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Executable name (basename, extension included is fine). */
  name: string;
  /** Full command line, or '' when the platform/permissions don't expose it. */
  cmd: string;
}

/** Agent binaries, by the name they run under. `agy` is Antigravity's CLI. */
const EXE_TO_AGENT: Record<string, AgentId> = {
  claude: 'claude',
  codex: 'codex',
  agy: 'antigravity',
  antigravity: 'antigravity',
};
const LAUNCH_TOKEN_RE = /(?:^|[\\/\s"'])(claude|codex|agy|antigravity)(?:\.(?:exe|cmd|bat|ps1|js))?(?=$|[\s"'])/i;
// A node-hosted CLI shows up as `node …/@anthropic-ai/claude-code/cli.js` (no bare agent token), which
// is how Claude Code runs off an npm install on macOS/Linux. Only the packages' own paths, never a
// loose mention of the name.
const PACKAGE_PATH_RULES: { re: RegExp; id: AgentId }[] = [
  { re: /@anthropic-ai[\\/]claude-code[\\/]/i, id: 'claude' },
  { re: /@openai[\\/]codex/i, id: 'codex' },
];
// A shell may nest a few hosts (npm shim → node → agent); beyond that we're into the agent's OWN
// children (tool calls, MCP servers), which must not decide the tile's provider.
const MAX_DEPTH = 6;
const CMD_CHARS = 400;

/** `claude.exe`, `/usr/bin/codex`, `agy.cmd` → the agent id; null for shells, node, anything else. */
export function agentFromExe(name: string): AgentId | null {
  const base = basename(String(name ?? '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|js)$/, '');
  return EXE_TO_AGENT[base] ?? null;
}

/**
 * The agent named in a command line (`pwsh -NoExit -Command "claude --resume …"`, `node …/claude …`).
 * Only ever applied to a DIRECT child of the tile's shell: deeper down, an agent's own tool call
 * (`bash -c "grep codex …"`) would otherwise masquerade as the tile's provider.
 */
export function agentFromCommandLine(cmd: string): AgentId | null {
  const text = String(cmd ?? '');
  const m = LAUNCH_TOKEN_RE.exec(text);
  if (m) return EXE_TO_AGENT[m[1].toLowerCase()] ?? null;
  return PACKAGE_PATH_RULES.find((r) => r.re.test(text))?.id ?? null;
}

/**
 * The agent running under `rootPid` (the tile's shell), or null when the shell is sitting at a bare
 * prompt. Breadth-first so the SHALLOWEST agent wins — if Claude Code shells out to `codex --version`,
 * the tile still belongs to Claude. `rootPid` itself is never matched: its command line still carries
 * the agent the tile was OPENED with, which is exactly the stale answer this replaces.
 */
export function agentFromProcessTree(rows: ProcRow[], rootPid: number): AgentId | null {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r); else byParent.set(r.ppid, [r]);
  }
  const seen = new Set<number>([rootPid]); // pid reuse can make the "tree" cyclic — visit each once
  let frontier = byParent.get(rootPid) ?? [];
  for (let depth = 1; frontier.length && depth <= MAX_DEPTH; depth++) {
    const next: ProcRow[] = [];
    let hit: { id: AgentId; pid: number } | null = null;
    for (const r of [...frontier].sort((a, b) => a.pid - b.pid)) { // stable pick among siblings
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      const id = agentFromExe(r.name) ?? (depth === 1 ? agentFromCommandLine(r.cmd) : null);
      if (id && !hit) hit = { id, pid: r.pid };
      next.push(...(byParent.get(r.pid) ?? []));
    }
    if (hit) return hit.id;
    frontier = next;
  }
  return null;
}

/** `pid|ppid|name|command line` lines from the Windows lister below. */
export function parseWindowsProcList(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, name: parts[2].trim(), cmd: parts.slice(3).join('|').trim().slice(0, CMD_CHARS) });
  }
  return rows;
}

/** `ps -eo pid=,ppid=,args=` output; the executable name is the first argv token. */
export function parseUnixProcList(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of String(out ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3].trim();
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: cmd.split(/\s+/)[0] ?? '', cmd: cmd.slice(0, CMD_CHARS) });
  }
  return rows;
}

export type Runner = (file: string, args: string[]) => Promise<string>;

const run: Runner = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    resolve(err && !stdout ? '' : String(stdout));
  });
});

// Windows PowerShell (5.1, always present — pwsh may not be) emits one pipe-delimited row per process.
// Newlines and pipes are stripped from the command line so one process is always one line.
const WIN_PS_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ($_.CommandLine -replace '[\\r\\n|]', ' ') }";

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  runner?: Runner;
  now?: () => number;
  /** How long one process listing is reused across tiles (the cockpit probes each tile on its tick). */
  ttlMs?: number;
}

/**
 * Cached process-tree prober: `probe(pid)` answers which agent runs under that pid. The listing costs
 * one short-lived child process, so it is taken at most once per TTL and shared by every live tile.
 */
export function makeAgentProbe(deps: ProbeDeps = {}): (rootPid: number) => Promise<AgentId | null> {
  const platform = deps.platform ?? process.platform;
  const runner = deps.runner ?? run;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 15_000;
  let cachedAt = -Infinity;
  let cached: ProcRow[] = [];
  let inFlight: Promise<ProcRow[]> | null = null;

  const list = async (): Promise<ProcRow[]> => {
    if (now() - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight; // concurrent tile probes share one listing
    inFlight = (async () => {
      const out = platform === 'win32'
        ? await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT])
        : await runner('ps', ['-eo', 'pid=,ppid=,args=']);
      return platform === 'win32' ? parseWindowsProcList(out) : parseUnixProcList(out);
    })();
    try {
      const rows = await inFlight;
      // An empty listing means the probe failed (no shell, timeout) — don't cache it as "nothing runs".
      if (rows.length) { cached = rows; cachedAt = now(); }
      return rows;
    } finally {
      inFlight = null;
    }
  };

  return async (rootPid: number) => {
    if (!Number.isFinite(rootPid) || rootPid <= 0) return null;
    const rows = await list();
    return rows.length ? agentFromProcessTree(rows, rootPid) : null;
  };
}
