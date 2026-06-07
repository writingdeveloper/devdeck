import { describe, it, expect } from 'vitest';
import { isAllowedPath } from './pathGuard';

const folders = [
  { path: 'C:\\work', kind: 'root' as const },
  { path: 'E:\\spike', kind: 'repo' as const },
];

describe('isAllowedPath', () => {
  it('allows a path under a root', () => {
    expect(isAllowedPath(folders, 'C:\\work\\projA')).toBe(true);
    expect(isAllowedPath(folders, 'C:\\work')).toBe(true);
  });
  it('rejects a sibling that merely shares a prefix', () => {
    expect(isAllowedPath(folders, 'C:\\work2\\projA')).toBe(false);
  });
  it('matches a repo entry only by exact path, not its children', () => {
    expect(isAllowedPath(folders, 'E:\\spike')).toBe(true);
    expect(isAllowedPath(folders, 'E:\\spike\\sub')).toBe(false);
  });
  it('rejects anything when no folders are configured', () => {
    expect(isAllowedPath([], 'C:\\work\\projA')).toBe(false);
  });
});
