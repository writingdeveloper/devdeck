import { describe, it, expect } from 'vitest';
import { buildWtArgs } from './wtArgs';

describe('buildWtArgs', () => {
  const projects = [
    { name: 'rockgaze', dir: 'C:\\g\\rockgaze' },
    { name: 'rentrights', dir: 'C:\\g\\rentrights' },
  ];

  it('builds one tab per project with a ; separator between them', () => {
    expect(buildWtArgs(projects, 'pwsh', 'claude -c')).toEqual([
      'new-tab', '--title', 'rockgaze', '-d', 'C:\\g\\rockgaze', 'pwsh', '-NoExit', '-Command', 'claude -c',
      ';',
      'new-tab', '--title', 'rentrights', '-d', 'C:\\g\\rentrights', 'pwsh', '-NoExit', '-Command', 'claude -c',
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
