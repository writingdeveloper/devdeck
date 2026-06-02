import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE = new Set(['__pycache__', '.pytest_cache', '.claude', '.playwright-mcp']);

export interface RawProject {
  path: string;
  name: string;
}

export function scanRepos(baseDir: string): RawProject[] {
  const out: RawProject[] = [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
    const full = join(baseDir, entry.name);
    if (existsSync(join(full, '.git'))) {
      out.push({ path: full, name: entry.name });
    }
  }
  return out;
}
