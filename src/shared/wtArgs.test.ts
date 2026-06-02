import { describe, it, expect } from 'vitest';
import { buildWtArgs } from './wtArgs';

describe('buildWtArgs', () => {
  const projects = [
    { name: 'repo-one', dir: 'C:\\g\\repo-one' },
    { name: 'repo-two', dir: 'C:\\g\\repo-two' },
  ];

  it('builds one tab per project with a ; separator between them', () => {
    expect(buildWtArgs(projects, 'pwsh', 'claude -c')).toEqual([
      'new-tab', '--title', 'repo-one', '-d', 'C:\\g\\repo-one', 'pwsh', '-NoExit', '-Command', 'claude -c',
      ';',
      'new-tab', '--title', 'repo-two', '-d', 'C:\\g\\repo-two', 'pwsh', '-NoExit', '-Command', 'claude -c',
    ]);
  });

  it('emits no leading separator for a single project', () => {
    const args = buildWtArgs([projects[0]], 'powershell', 'claude -c');
    expect(args[0]).toBe('new-tab');
    expect(args).not.toContain(';');
  });

  it('throws on an empty project list', () => {
    expect(() => buildWtArgs([], 'pwsh', 'claude -c')).toThrow();
  });
});
