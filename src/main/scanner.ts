import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const IGNORE = new Set(['__pycache__', '.pytest_cache', '.claude', '.playwright-mcp', 'node_modules']);

export interface RawProject {
  path: string;
  name: string;
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, depth: number, maxDepth: number, out: RawProject[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORE.has(e.name))
      .map(async (entry) => {
        const full = join(dir, entry.name);
        if (await isRepo(full)) {
          out.push({ path: full, name: entry.name }); // a repo — include it, don't descend into it
        } else if (depth < maxDepth) {
          await walk(full, depth + 1, maxDepth, out); // not a repo — look one level deeper (org/repo layouts)
        }
      }),
  );
}

/** Find git repos under baseDir, scanning up to maxDepth levels (default 2 = org/repo). */
export async function scanRepos(baseDir: string, maxDepth = 2): Promise<RawProject[]> {
  const out: RawProject[] = [];
  await walk(baseDir, 1, maxDepth, out);
  return out;
}
