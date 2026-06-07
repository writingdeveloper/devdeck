import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { isAllowedPath } from './pathGuard';

// Build OS-native absolute paths so the test exercises the same separator/`resolve`
// semantics the guard uses on whatever platform runs it (CI runs ubuntu/macos/windows).
const root = resolve(sep, 'work');
const repo = resolve(sep, 'spike');
const folders = [
  { path: root, kind: 'root' as const },
  { path: repo, kind: 'repo' as const },
];

describe('isAllowedPath', () => {
  it('allows a path under a root', () => {
    expect(isAllowedPath(folders, join(root, 'projA'))).toBe(true);
    expect(isAllowedPath(folders, root)).toBe(true);
  });
  it('rejects a sibling that merely shares a prefix', () => {
    expect(isAllowedPath(folders, resolve(sep, 'work2', 'projA'))).toBe(false);
  });
  it('matches a repo entry only by exact path, not its children', () => {
    expect(isAllowedPath(folders, repo)).toBe(true);
    expect(isAllowedPath(folders, join(repo, 'sub'))).toBe(false);
  });
  it('rejects anything when no folders are configured', () => {
    expect(isAllowedPath([], join(root, 'projA'))).toBe(false);
  });
});
