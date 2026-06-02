import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildWtArgs, type WtTab } from '../shared/wtArgs';

export type SpawnFn = (file: string, args: string[]) => void;

export interface OpenOptions {
  wtPath: string;
  shell: string;
  command: string;
  spawnFn?: SpawnFn;
}

const defaultSpawn: SpawnFn = (file, args) => {
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
};

export function openProjects(projects: WtTab[], opts: OpenOptions): void {
  if (projects.length === 0) return;
  const args = buildWtArgs(projects, opts.shell, opts.command);
  (opts.spawnFn ?? defaultSpawn)(opts.wtPath, args);
}

/** Resolve wt.exe, preferring PATH, falling back to the WindowsApps alias path. */
export function resolveWtPath(): string {
  const fallback = join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft', 'WindowsApps', 'wt.exe',
  );
  return existsSync(fallback) ? fallback : 'wt.exe';
}
