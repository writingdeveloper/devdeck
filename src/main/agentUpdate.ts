// src/main/agentUpdate.ts
// `claude update`, run by DevDeck while no session holds the executable.
//
// On Windows the updater cannot replace claude.exe while any session is running it
// (`windows_running_exe_lock`), so with a deck of sessions open an update never lands. The cockpit
// stops its Claude sessions, calls this, and brings the same conversations back.
import { spawn } from 'node:child_process';
import { cliInvocation, killChildTree } from './aiSummary';
import { resolveAgentCliPath } from './cliExecutable';

export interface AgentUpdateResult { ok: boolean; code: number | null; output: string }

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 2000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function runClaudeUpdate(): Promise<AgentUpdateResult> {
  return new Promise((resolve) => {
    const how = cliInvocation(resolveAgentCliPath('claude'), ['update']);
    let output = '';
    let settled = false;
    const finish = (r: AgentUpdateResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(how.file, how.args, { windowsHide: true, windowsVerbatimArguments: how.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: null, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    const take = (c: Buffer): void => { output = (output + c.toString('utf8')).slice(-OUTPUT_TAIL_CHARS * 4); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => { killChildTree(child); finish({ ok: false, code: null, output: tail(output) + '\n(timed out)' }); }, UPDATE_TIMEOUT_MS);
    child.on('error', (err) => finish({ ok: false, code: null, output: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, output: tail(output) }));
  });
}

function tail(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').trim().slice(-OUTPUT_TAIL_CHARS);
}
