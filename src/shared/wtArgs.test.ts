import { describe, it, expect } from 'vitest';
import { buildWtArgs } from './wtArgs';

describe('buildWtArgs', () => {
  const tabs = [
    { name: 'repo-one', dir: 'C:\\g\\repo-one', command: 'claude -r aaa' },
    { name: 'repo-two', dir: 'C:\\g\\repo-two', command: 'claude -r bbb' },
  ];

  it('targets the current window (-w 0) and runs each tab\'s own command', () => {
    expect(buildWtArgs(tabs, 'pwsh')).toEqual([
      '-w', '0',
      'new-tab', '--title', 'repo-one', '-d', 'C:\\g\\repo-one', 'pwsh', '-NoExit', '-Command', 'claude -r aaa',
      ';',
      'new-tab', '--title', 'repo-two', '-d', 'C:\\g\\repo-two', 'pwsh', '-NoExit', '-Command', 'claude -r bbb',
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
