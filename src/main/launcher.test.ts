import { describe, it, expect } from 'vitest';
import { openProjects, resolveShell, resolveWtPath } from './launcher';

describe('openProjects', () => {
  it('spawns wt once with a tab per project', () => {
    const calls: { file: string; args: string[] }[] = [];
    const fakeSpawn = (file: string, args: string[]) => { calls.push({ file, args }); };

    openProjects(
      [
        { name: 'a', dir: 'C:\\g\\a', command: 'claude -r 1' },
        { name: 'b', dir: 'C:\\g\\b', command: 'claude -r 2' },
      ],
      { wtPath: 'wt.exe', shell: 'pwsh', spawnFn: fakeSpawn },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('wt.exe');
    expect(calls[0].args.slice(0, 2)).toEqual(['-w', '0']);
    expect(calls[0].args.filter((x) => x === 'new-tab')).toHaveLength(2);
  });

  it('does nothing for an empty selection', () => {
    let called = false;
    openProjects([], { wtPath: 'wt.exe', shell: 'pwsh', spawnFn: () => { called = true; } });
    expect(called).toBe(false);
  });
});

describe('resolveShell', () => {
  it('returns pwsh when pwsh is present', () => {
    expect(resolveShell(() => true)).toBe('pwsh');
  });
  it('falls back to powershell when pwsh is absent', () => {
    expect(resolveShell(() => false)).toBe('powershell');
  });
});

describe('resolveWtPath', () => {
  // Regression: spawning the bare alias name `wt.exe` fails with ENOENT (Node's
  // PATH search stat-rejects the reparse-point alias). We must return the FULL
  // WindowsApps path so CreateProcess can resolve the alias.
  it('returns the full WindowsApps alias path, not the bare name', () => {
    expect(resolveWtPath('C:\\Users\\x\\AppData\\Local')).toBe(
      'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
    );
  });
  it('falls back to the bare name when LOCALAPPDATA is empty/unset', () => {
    expect(resolveWtPath('')).toBe('wt.exe');
  });
});
