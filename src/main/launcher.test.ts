import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { openProjects, resolveShell, resolveWtPath, detectLinuxTerminal, editorSpec, openInEditor, resolveShellPath, makeCliGuard } from './launcher';
import type { WtTab } from '../shared/wtArgs';

type Call = { file: string; args: string[] };
const sink = () => { const calls: Call[] = []; return { calls, fn: (file: string, args: string[]) => { calls.push({ file, args }); } }; };

const tabs: WtTab[] = [
  { name: 'a', dir: '/g/a', command: 'claude -r a0b1c2d3' },
  { name: 'b', dir: '/g/b', command: 'claude -c' },
];

describe('openProjects (Windows)', () => {
  it('spawns wt once with a tab per project', () => {
    const { calls, fn } = sink();
    openProjects(
      [{ name: 'a', dir: 'C:\\g\\a', command: 'claude -r 1' }, { name: 'b', dir: 'C:\\g\\b', command: 'claude -r 2' }],
      { platform: 'win32', wtPath: 'wt.exe', shell: 'pwsh', spawnFn: fn },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('wt.exe');
    expect(calls[0].args.slice(0, 2)).toEqual(['-w', '0']);
    expect(calls[0].args.filter((x) => x === 'new-tab')).toHaveLength(2);
  });

  it('does nothing for an empty selection', () => {
    let called = false;
    openProjects([], { platform: 'win32', spawnFn: () => { called = true; } });
    expect(called).toBe(false);
  });
});

describe('openProjects (macOS)', () => {
  it('spawns osascript once per project with dir+command as trailing argv', () => {
    const { calls, fn } = sink();
    openProjects(tabs, { platform: 'darwin', spawnFn: fn });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.file === 'osascript')).toBe(true);
    expect(calls[0].args.slice(-2)).toEqual(['/g/a', 'claude -r a0b1c2d3']);
  });
});

describe('openProjects (Linux)', () => {
  it('spawns the chosen terminal once per project', () => {
    const { calls, fn } = sink();
    openProjects(tabs, { platform: 'linux', linuxTerm: 'gnome-terminal', spawnFn: fn });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.file === 'gnome-terminal')).toBe(true);
  });

  it('reports an error and spawns nothing when no terminal is found', () => {
    let spawned = 0; let err = '';
    openProjects(tabs, { platform: 'linux', linuxTerm: null, spawnFn: () => { spawned++; }, onError: (m) => { err = m; } });
    expect(spawned).toBe(0);
    expect(err).toContain('No supported terminal');
  });
});

describe('detectLinuxTerminal', () => {
  it('returns the first installed terminal in preference order', () => {
    expect(detectLinuxTerminal((c) => c === 'konsole')).toBe('konsole');
  });
  it('returns null when none are installed', () => {
    expect(detectLinuxTerminal(() => false)).toBeNull();
  });
});

describe('editorSpec', () => {
  it('posix: code with the dir as an args-array entry (no shell)', () => {
    expect(editorSpec('/g/a', 'darwin')).toEqual({ command: 'code', args: ['/g/a'], shell: false });
    expect(editorSpec('/g/a', 'linux')).toEqual({ command: 'code', args: ['/g/a'], shell: false });
  });
  it('windows: quoted path through a shell (code is code.cmd)', () => {
    expect(editorSpec('C:\\g\\a', 'win32')).toEqual({ command: 'code "C:\\g\\a"', args: [], shell: true });
  });
});

describe('openInEditor', () => {
  it('dispatches the editor spec to spawnFn', () => {
    let got: { c: string; a: string[]; s: boolean } | null = null;
    openInEditor('/g/a', { platform: 'linux', spawnFn: (c, a, s) => { got = { c, a, s }; } });
    expect(got).toEqual({ c: 'code', a: ['/g/a'], s: false });
  });
});

describe('resolveShell', () => {
  it('returns pwsh when present', () => { expect(resolveShell(() => true)).toBe('pwsh'); });
  it('falls back to powershell when absent', () => { expect(resolveShell(() => false)).toBe('powershell'); });
});

describe('resolveWtPath', () => {
  it('returns the full WindowsApps alias path', () => {
    expect(resolveWtPath('C:\\Users\\x\\AppData\\Local')).toBe('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe');
  });
  it('falls back to the bare name when LOCALAPPDATA is empty', () => {
    expect(resolveWtPath('')).toBe('wt.exe');
  });
});

describe('resolveShellPath', () => {
  it.skipIf(process.platform !== 'win32')('returns an existing PowerShell executable on Windows', () => {
    expect(existsSync(resolveShellPath())).toBe(true);
  });
});

describe('makeCliGuard', () => {
  it('resolves null when the command binary is on PATH', async () => {
    const guard = makeCliGuard(() => true);
    await expect(guard('claude --resume abc')).resolves.toBeNull();
  });
  it('returns an actionable message naming the missing binary', async () => {
    const guard = makeCliGuard(() => false);
    const msg = await guard('claude -c');
    expect(msg).toContain("'claude'");
    expect(msg).toContain('PATH');
  });
  it('includes the install command for the claude CLI specifically', async () => {
    const guard = makeCliGuard(() => false);
    await expect(guard('claude')).resolves.toContain('npm install -g @anthropic-ai/claude-code');
    await expect(guard('agy')).resolves.not.toContain('npm install');
  });
  it('gives Codex its named installation and PATH hint without changing other CLI hints', async () => {
    const guard = makeCliGuard(() => false);
    await expect(guard('codex resume')).resolves.toContain('Install Codex CLI first: npm install -g @openai/codex');
    await expect(guard('claude')).resolves.toContain('npm install -g @anthropic-ai/claude-code');
    await expect(guard('agy')).resolves.not.toContain('npm install');
  });
  it('caches a found binary but re-probes a missing one (installing mid-session clears the warning)', async () => {
    let onPath = false;
    let probes = 0;
    const guard = makeCliGuard(() => { probes++; return onPath; });
    await expect(guard('claude -c')).resolves.toContain('PATH'); // miss — must NOT be cached
    onPath = true; // user ran the install command from the toast
    await expect(guard('claude --resume x')).resolves.toBeNull(); // re-probed, now found
    await guard('claude'); // found is cached — no third probe
    expect(probes).toBe(2);
  });
  it('supports an async probe', async () => {
    const guard = makeCliGuard(async () => false);
    await expect(guard('agy')).resolves.toContain("'agy'");
  });
  it('is silent for an empty command', async () => {
    const guard = makeCliGuard(() => false);
    await expect(guard('')).resolves.toBeNull();
    await expect(guard('   ')).resolves.toBeNull();
  });
});
