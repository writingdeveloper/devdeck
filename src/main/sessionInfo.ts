import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';

/** Newest *.jsonl mtime (ms) under <claudeProjectsDir>/<encoded(projectPath)>/, or null. */
export function getLastSessionMs(projectPath: string, claudeProjectsDir: string): number | null {
  const dir = join(claudeProjectsDir, encodeProjectPath(projectPath));
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const m = statSync(join(dir, name)).mtimeMs;
    if (newest == null || m > newest) newest = m;
  }
  return newest;
}
