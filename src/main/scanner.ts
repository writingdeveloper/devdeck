import { readdir, access, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import type { Folder } from '../shared/types';

// Never descend into these. The Windows entries matter now that a whole drive is usable as a scan
// folder (`E:\`): neither starts with a dot, so the dot-prefix skip misses them, and one of them
// throws EPERM on every refresh while the other is a recycle bin full of deleted junk.
const IGNORE = new Set([
  '__pycache__', '.pytest_cache', '.claude', '.playwright-mcp', 'node_modules',
  '$RECYCLE.BIN', 'System Volume Information', '$WinREAgent', 'Recovery',
]);
const ignored = (name: string): boolean => IGNORE.has(name) || IGNORE.has(name.toUpperCase());

export interface RawProject {
  path: string;
  name: string;
}

export async function isRepo(dir: string): Promise<boolean> {
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
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !ignored(e.name))
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

function dedupeByResolvedPath(items: RawProject[]): RawProject[] {
  const seen = new Set<string>();
  const out: RawProject[] = [];
  for (const it of items) {
    const key = resolve(it.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan every configured folder: `root` walked depth-2 for git repos, `repo` (the user pointed at ONE
 * folder and said "this is a project") included as itself; deduped by resolved path.
 *
 * A `repo` entry only has to EXIST — it deliberately does not need a `.git`. Requiring one meant a
 * folder the user had explicitly added vanished from the deck with no explanation whenever it wasn't
 * a git repo yet, which is the normal state of a project on day one. A missing folder still drops out
 * so a deleted or unplugged directory doesn't linger.
 */
export async function scanFolders(folders: Folder[]): Promise<RawProject[]> {
  const chunks = await Promise.all(
    folders.map((f) =>
      f.kind === 'repo'
        // basename('E:\\') is '' — fall back to the path so a drive added as a single folder still has a label.
        ? isDir(f.path).then((ok) => (ok ? [{ path: f.path, name: basename(f.path) || f.path }] : []))
        : scanRepos(f.path),
    ),
  );
  return dedupeByResolvedPath(chunks.flat());
}
