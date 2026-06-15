import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { openProjects, resolveShell, resolveWtPath, detectLinuxTerminal, editorSpec, openInEditor, resolveShellPath } from './launcher';
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
