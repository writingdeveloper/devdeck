import { describe, it, expect } from 'vitest';
import { buildWtArgs } from './wtArgs';

describe('buildWtArgs', () => {
  const tabs = [
    { name: 'rockgaze', dir: 'C:\\g\\rockgaze', command: 'claude -r aaa' },
    { name: 'rentrights', dir: 'C:\\g\\rentrights', command: 'claude -r bbb' },
  ];

  it('targets the current window (-w 0) and runs each tab\'s own command', () => {
    expect(buildWtArgs(tabs, 'pwsh')).toEqual([
      '-w', '0',
      'new-tab', '--title', 'rockgaze', '-d', 'C:\\g\\rockgaze', 'pwsh', '-NoExit', '-Command', 'claude -r aaa',
      ';',
      'new-tab', '--title', 'rentrights', '-d', 'C:\\g\\rentrights', 'pwsh', '-NoExit', '-Command', 'claude -r bbb',
    ]);
  });

  it('emits no ; separator for a single tab', () => {
    const args = buildWtArgs([tabs[0]], 'powershell');
    expect(args.slice(0, 2)).toEqual(['-w', '0']);
    expect(args).not.toContain(';');
  });

  it('throws on an empty tab list', () => {
    expect(() => buildWtArgs([], 'pwsh')).toThrow();
  });
});
