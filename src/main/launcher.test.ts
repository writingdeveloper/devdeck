import { describe, it, expect } from 'vitest';
import { openProjects } from './launcher';

describe('openProjects', () => {
  it('spawns wt once with new-tab args for each project', () => {
    const calls: { file: string; args: string[] }[] = [];
    const fakeSpawn = (file: string, args: string[]) => { calls.push({ file, args }); };

    openProjects(
      [{ name: 'a', dir: 'C:\\g\\a' }, { name: 'b', dir: 'C:\\g\\b' }],
      { wtPath: 'wt.exe', shell: 'pwsh', command: 'claude -c', spawnFn: fakeSpawn },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('wt.exe');
    expect(calls[0].args.filter((a) => a === 'new-tab')).toHaveLength(2);
    expect(calls[0].args).toContain(';');
    expect(calls[0].args).toContain('claude -c');
  });

  it('does nothing for an empty selection', () => {
    let called = false;
    openProjects([], { wtPath: 'wt.exe', shell: 'pwsh', command: 'claude -c', spawnFn: () => { called = true; } });
    expect(called).toBe(false);
  });
});
