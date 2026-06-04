import { describe, it, expect } from 'vitest';
import { buildMacLaunch, buildLinuxLaunch } from './posixLaunch';
import type { WtTab } from './wtArgs';

const tab = (over: Partial<WtTab> = {}): WtTab => ({ name: 'proj', dir: '/Users/x/proj', command: 'claude -c', ...over });

describe('buildMacLaunch', () => {
  it('returns one osascript invocation per tab, passing dir+command as trailing argv', () => {
    const cmds = buildMacLaunch([tab(), tab({ dir: '/Users/x/b', command: 'claude -r a0b1c2d3' })]);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].file).toBe('osascript');
    // dir and command are passed as argv (NOT interpolated into the script) -> no AppleScript injection
    expect(cmds[0].args.slice(-2)).toEqual(['/Users/x/proj', 'claude -c']);
    expect(cmds[1].args.slice(-2)).toEqual(['/Users/x/b', 'claude -r a0b1c2d3']);
  });

  it('declares an argv run handler and quotes the directory via "quoted form of"', () => {
    const [cmd] = buildMacLaunch([tab()]);
    expect(cmd.args).toContain('on run argv');
    const doScript = cmd.args.find((a) => a.includes('do script'));
    expect(doScript).toBeDefined();
    expect(doScript!).toContain('quoted form of (item 1 of argv)');
    expect(doScript!).toContain('item 2 of argv');
  });

  it('never interpolates dir/command into the -e script bodies (injection-safe)', () => {
    const evil = tab({ dir: '/p"; do shell script "rm -rf ~', command: 'claude -c' });
    const [cmd] = buildMacLaunch([evil]);
    const scriptBodies = cmd.args.filter((a, i) => cmd.args[i - 1] === '-e').join('\n');
    expect(scriptBodies).not.toContain('rm -rf');
    expect(cmd.args).toContain('/p"; do shell script "rm -rf ~'); // present only as a trailing argv value
  });
});

describe('buildLinuxLaunch', () => {
  it('gnome-terminal: uses --working-directory and -- bash -lc', () => {
    const [cmd] = buildLinuxLaunch([tab()], 'gnome-terminal');
    expect(cmd).toEqual({
      file: 'gnome-terminal',
      args: ['--working-directory=/Users/x/proj', '--', 'bash', '-lc', 'claude -c; exec bash'],
    });
  });

  it('konsole: uses --workdir and -e bash -lc', () => {
    const [cmd] = buildLinuxLaunch([tab()], 'konsole');
    expect(cmd).toEqual({
      file: 'konsole',
      args: ['--workdir', '/Users/x/proj', '-e', 'bash', '-lc', 'claude -c; exec bash'],
    });
  });

  it('xterm/x-terminal-emulator: cd into a single-quoted dir inside bash -lc', () => {
    const [xt] = buildLinuxLaunch([tab()], 'xterm');
    expect(xt).toEqual({ file: 'xterm', args: ['-e', 'bash', '-lc', "cd '/Users/x/proj' && claude -c; exec bash"] });
    const [xte] = buildLinuxLaunch([tab()], 'x-terminal-emulator');
    expect(xte.file).toBe('x-terminal-emulator');
    expect(xte.args).toEqual(['-e', 'bash', '-lc', "cd '/Users/x/proj' && claude -c; exec bash"]);
  });

  it('shell-escapes single quotes in the directory path', () => {
    const [cmd] = buildLinuxLaunch([tab({ dir: "/p/o'brien" })], 'xterm');
    expect(cmd.args[3]).toBe("cd '/p/o'\\''brien' && claude -c; exec bash");
  });

  it('falls back to xterm-style for an unknown terminal', () => {
    const [cmd] = buildLinuxLaunch([tab()], 'mystery-term');
    expect(cmd.file).toBe('mystery-term');
    expect(cmd.args.slice(0, 3)).toEqual(['-e', 'bash', '-lc']);
  });
});
