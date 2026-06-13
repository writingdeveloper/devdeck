import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Folder } from '../shared/types';
import { isAllowedPath } from '../shared/pathGuard';
import { validateProjectName, type NameError } from '../shared/projectName';

export type CreateError = NameError | 'parent_not_allowed' | 'exists' | 'mkdir_failed';

export interface CreateProjectResult {
  ok: boolean;
  path?: string;
  /** Whether `git init` succeeded — when false the scanner can't discover the folder. */
  gitInitialized?: boolean;
  error?: CreateError;
}

export interface CreateDeps {
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
  gitInit?: (cwd: string) => boolean;
}

function defaultGitInit(cwd: string): boolean {
  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new project folder under an allowed parent and `git init` it.
 *
 * `git init` is not cosmetic: the scanner only surfaces folders that contain a
 * `.git` directory, so initialising the repo is what makes the new project appear
 * in the deck. The parent must be a configured folder (same `isAllowedPath` guard
 * used by open/openFolder) so a compromised renderer can't mkdir anywhere on disk.
 *
 * Pure given its injected deps; production callers use the real fs/git defaults.
 */
export function createProject(
  folders: Folder[],
  parent: string,
  rawName: string,
  deps: CreateDeps = {},
): CreateProjectResult {
  const exists = deps.exists ?? existsSync;
  const mkdir = deps.mkdir ?? ((p: string) => { mkdirSync(p); });
  const gitInit = deps.gitInit ?? defaultGitInit;

  const check = validateProjectName(rawName);
  if (!check.ok) return { ok: false, error: check.reason };
  if (!isAllowedPath(folders, parent)) return { ok: false, error: 'parent_not_allowed' };

  const target = join(parent, check.name);
  if (exists(target)) return { ok: false, error: 'exists' };
  try {
    mkdir(target);
  } catch {
    return { ok: false, error: 'mkdir_failed' };
  }
  return { ok: true, path: target, gitInitialized: gitInit(target) };
}
