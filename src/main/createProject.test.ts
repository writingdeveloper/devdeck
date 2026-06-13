import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from './createProject';
import type { Folder } from '../shared/types';

let root: string;
let folders: Folder[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdeck-create-'));
  folders = [{ path: root, kind: 'root' }];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A git stub that records where it was invoked, so tests stay fast and offline.
function gitSpy() {
  const calls: string[] = [];
  return { calls, gitInit: (cwd: string) => { calls.push(cwd); return true; } };
}

describe('createProject', () => {
  it('creates the folder under an allowed root and git-inits it', () => {
    const git = gitSpy();
    const res = createProject(folders, root, 'fresh-app', { gitInit: git.gitInit });
    const target = join(root, 'fresh-app');
    expect(res).toEqual({ ok: true, path: target, gitInitialized: true });
    expect(existsSync(target)).toBe(true);
    expect(git.calls).toEqual([target]);
  });

  it('trims the name before creating the folder', () => {
    const res = createProject(folders, root, '  spaced  ', { gitInit: () => true });
    expect(res.path).toBe(join(root, 'spaced'));
    expect(existsSync(join(root, 'spaced'))).toBe(true);
  });

  it('refuses a parent that is not a configured folder, and creates nothing', () => {
    const git = gitSpy();
    const outside = join(root, '..', 'elsewhere');
    const res = createProject(folders, outside, 'x', { gitInit: git.gitInit });
    expect(res).toEqual({ ok: false, error: 'parent_not_allowed' });
    expect(git.calls).toEqual([]);
  });

  it('rejects an invalid name without touching the filesystem', () => {
    const git = gitSpy();
    const res = createProject(folders, root, 'a/b', { gitInit: git.gitInit });
    expect(res).toEqual({ ok: false, error: 'chars' });
    expect(existsSync(join(root, 'a'))).toBe(false);
    expect(git.calls).toEqual([]);
  });

  it('rejects when a folder of the same name already exists', () => {
    createProject(folders, root, 'dup', { gitInit: () => true });
    const res = createProject(folders, root, 'dup', { gitInit: () => true });
    expect(res).toEqual({ ok: false, error: 'exists' });
  });

  it('still reports success but flags gitInitialized=false when git is unavailable', () => {
    const res = createProject(folders, root, 'nogit', { gitInit: () => false });
    expect(res.ok).toBe(true);
    expect(res.gitInitialized).toBe(false);
    expect(existsSync(join(root, 'nogit'))).toBe(true);
  });
});
