import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const IGNORE = new Set(['__pycache__', '.pytest_cache', '.claude', '.playwright-mcp']);

export interface RawProject {
  path: string;
  name: string;
}

export async function scanRepos(baseDir: string): Promise<RawProject[]> {
  const out: RawProject[] = [];
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORE.has(e.name))
      .map(async (entry) => {
        const full = join(baseDir, entry.name);
        try {
          await access(join(full, '.git'));
          out.push({ path: full, name: entry.name });
        } catch { /* no .git */ }
      }),
  );
  return out;
}
