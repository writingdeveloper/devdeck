import { describe, expect, it, vi } from 'vitest';
import {
  agentFromCommandLine,
  agentFromExe,
  agentFromProcessTree,
  makeAgentProbe,
  parseUnixProcList,
  parseWindowsProcList,
  type ProcRow,
} from './agentProcess';

const row = (pid: number, ppid: number, name: string, cmd = ''): ProcRow => ({ pid, ppid, name, cmd });

describe('agentFromExe', () => {
  it('maps agent binaries, whatever the path or extension', () => {
    expect(agentFromExe('claude.exe')).toBe('claude');
    expect(agentFromExe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')).toBe('claude');
    expect(agentFromExe('/usr/local/bin/codex')).toBe('codex');
    expect(agentFromExe('agy')).toBe('antigravity');
  });
  it('is null for shells and hosts', () => {
    for (const n of ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'node.exe', 'bash', 'DevDeck.exe', '']) {
      expect(agentFromExe(n)).toBeNull();
    }
  });
});

describe('agentFromCommandLine', () => {
  it('finds the agent a shell was told to run', () => {
    expect(agentFromCommandLine('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoExit -Command "codex resume 019f"')).toBe('codex');
    expect(agentFromCommandLine('pwsh -NoExit -Command "claude --resume abc"')).toBe('claude');
    // A node-hosted CLI has no bare agent token — recognized by its own package path instead.
    expect(agentFromCommandLine('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
    expect(agentFromCommandLine('node /opt/npm/@openai/codex/bin/index.js')).toBe('codex');
    expect(agentFromCommandLine('node /opt/bin/agy --conversation 7')).toBe('antigravity');
  });
  it('does not match an agent name embedded in another word', () => {
    expect(agentFromCommandLine('git commit -m "codexes and claudelike things"')).toBeNull();
    expect(agentFromCommandLine('rg --files ~/GitHub/codex-notes')).toBeNull();
  });
});

describe('agentFromProcessTree', () => {
  const SHELL = 100;

  it('reports the agent running under the tile shell', () => {
    const rows = [row(SHELL, 9, 'pwsh.exe', 'pwsh -NoExit -Command "codex resume 019f"'), row(101, SHELL, 'codex.exe')];
    expect(agentFromProcessTree(rows, SHELL)).toBe('codex');
  });

  // The bug: `codex resume` finished, the -NoExit shell kept its prompt, the user typed `claude`.
  // The shell's OWN command line still says codex, so the root must never be matched.
  it('follows the agent the user typed later, not the shell command line', () => {
    const rows = [row(SHELL, 9, 'pwsh.exe', 'pwsh -NoExit -Command "codex resume 019f"'), row(101, SHELL, 'claude.exe')];
    expect(agentFromProcessTree(rows, SHELL)).toBe('claude');
  });

  it('is null while the shell sits at a bare prompt (caller keeps what it has)', () => {
    expect(agentFromProcessTree([row(SHELL, 9, 'pwsh.exe', 'pwsh -NoExit -Command "codex resume 019f"')], SHELL)).toBeNull();
  });

  it('ignores other tiles: only descendants of THIS shell count', () => {
    const rows = [row(SHELL, 9, 'pwsh.exe'), row(200, 9, 'pwsh.exe'), row(201, 200, 'codex.exe')];
    expect(agentFromProcessTree(rows, SHELL)).toBeNull();
  });

  it('the shallowest agent wins — an agent shelling out to another agent does not steal the tile', () => {
    const rows = [
      row(SHELL, 9, 'pwsh.exe'),
      row(101, SHELL, 'claude.exe'),
      row(102, 101, 'pwsh.exe', 'pwsh -c "codex --version"'),
      row(103, 102, 'codex.exe'),
    ];
    expect(agentFromProcessTree(rows, SHELL)).toBe('claude');
  });

  it('a nested tool call whose command line merely mentions an agent is not a match', () => {
    const rows = [
      row(SHELL, 9, 'pwsh.exe'),
      row(101, SHELL, 'node.exe', 'node cli.js'),
      row(102, 101, 'bash.exe', 'bash -c "grep -rn codex src"'),
    ];
    expect(agentFromProcessTree(rows, SHELL)).toBeNull();
  });

  it('finds an agent launched through a shim a couple of levels down', () => {
    const rows = [row(SHELL, 9, 'pwsh.exe'), row(101, SHELL, 'cmd.exe', 'cmd /c claude.cmd'), row(102, 101, 'claude.exe')];
    expect(agentFromProcessTree(rows, SHELL)).toBe('claude');
  });

  it('survives a cyclic tree from pid reuse', () => {
    const rows = [row(SHELL, 9, 'pwsh.exe'), row(101, SHELL, 'node.exe'), row(SHELL, 101, 'pwsh.exe')];
    expect(agentFromProcessTree(rows, SHELL)).toBeNull();
  });
});

describe('process list parsing', () => {
  it('windows pipe rows, with pipes inside the command line kept out of the way', () => {
    const out = '4321|100|claude.exe|"C:\\claude.exe" --resume a|b\r\n100|9|pwsh.exe|pwsh -NoExit\r\nheader junk\r\n';
    expect(parseWindowsProcList(out)).toEqual([
      { pid: 4321, ppid: 100, name: 'claude.exe', cmd: '"C:\\claude.exe" --resume a|b' },
      { pid: 100, ppid: 9, name: 'pwsh.exe', cmd: 'pwsh -NoExit' },
    ]);
  });
  it('unix ps rows derive the name from argv[0]', () => {
    expect(parseUnixProcList(' 4321   100 /usr/local/bin/codex resume 019f\n  100     9 -zsh\n')).toEqual([
      { pid: 4321, ppid: 100, name: '/usr/local/bin/codex', cmd: '/usr/local/bin/codex resume 019f' },
      { pid: 100, ppid: 9, name: '-zsh', cmd: '-zsh' },
    ]);
  });
});

describe('makeAgentProbe', () => {
  const winOut = '100|9|pwsh.exe|pwsh -NoExit -Command "codex resume 019f"\r\n101|100|claude.exe|claude';

  it('answers from the process tree and reuses one listing within the TTL', async () => {
    const runner = vi.fn(async () => winOut);
    let now = 1000;
    const probe = makeAgentProbe({ platform: 'win32', runner, now: () => now, ttlMs: 15_000 });

    expect(await probe(100)).toBe('claude');
    expect(await probe(100)).toBe('claude');
    expect(runner).toHaveBeenCalledTimes(1); // second tile/tick shares the listing

    now += 20_000;
    expect(await probe(100)).toBe('claude');
    expect(runner).toHaveBeenCalledTimes(2); // TTL expired → re-listed
  });

  it('concurrent probes share a single listing', async () => {
    const runner = vi.fn(async () => winOut);
    const probe = makeAgentProbe({ platform: 'win32', runner, now: () => 0 });
    expect(await Promise.all([probe(100), probe(100), probe(100)])).toEqual(['claude', 'claude', 'claude']);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('a failed listing answers null and is not cached as "nothing is running"', async () => {
    const runner = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce(winOut);
    const probe = makeAgentProbe({ platform: 'win32', runner, now: () => 0 });
    expect(await probe(100)).toBeNull();
    expect(await probe(100)).toBe('claude'); // retried despite the TTL, since nothing was cached
  });

  it('rejects a missing pid without listing anything', async () => {
    const runner = vi.fn(async () => winOut);
    const probe = makeAgentProbe({ platform: 'win32', runner, now: () => 0 });
    expect(await probe(0)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses ps on non-windows platforms', async () => {
    const runner = vi.fn(async () => ' 101 100 /usr/local/bin/codex resume 019f\n 100 9 -zsh\n');
    const probe = makeAgentProbe({ platform: 'darwin', runner, now: () => 0 });
    expect(await probe(100)).toBe('codex');
    expect(runner).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,args=']);
  });
});
