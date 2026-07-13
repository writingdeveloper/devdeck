import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Newest transcript (.jsonl) mtime across every project dir under ~/.claude/projects — the
 * "an EXTERNAL session (terminal/VSCode, not the cockpit) is still busy" signal for the
 * idle-shutdown watcher. Fully async and best-effort per entry: only polled every ~30s and
 * only while a shutdown is armed, so the walk's cost (one stat per session file) is fine.
 * Returns 0 when nothing is found or the root is unreadable.
 */
export async function latestTranscriptMtime(claudeProjectsDir: string): Promise<number> {
  let latest = 0;
  let dirs: string[];
  try { dirs = await readdir(claudeProjectsDir); } catch { return 0; }
  for (const d of dirs) {
    let files: string[];
    try { files = await readdir(join(claudeProjectsDir, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const m = (await stat(join(claudeProjectsDir, d, f))).mtimeMs;
        if (m > latest) latest = m;
      } catch { /* file vanished mid-walk */ }
    }
  }
  return latest;
}
