import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { isAllowedPath, isAllowedFilePath } from './pathGuard';

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

describe('isAllowedFilePath', () => {
  // FILE access (e.g. click-to-open an image the agent printed) differs from PROJECT identity:
  // a file inside a registered individual repo is fair game even though the repo entry itself
  // only matches exactly for project-level actions.
  it('allows files under a root AND under a repo entry', () => {
    expect(isAllowedFilePath(folders, join(root, 'projA', 'img.png'))).toBe(true);
    expect(isAllowedFilePath(folders, join(repo, 'assets', 'img.png'))).toBe(true);
  });
  it('still rejects anything outside every configured folder', () => {
    expect(isAllowedFilePath(folders, resolve(sep, 'elsewhere', 'img.png'))).toBe(false);
    expect(isAllowedFilePath([], join(root, 'img.png'))).toBe(false);
  });
});
