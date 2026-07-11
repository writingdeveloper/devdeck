import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverProjectFromLines, type ClaudeProjectRef } from '../shared/usageProjects';

const HEAD_BYTES = 65_536; // cwd appears within the first few lines — read only the head (session files can be MBs)

async function readHead(file: string): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fh.close(); }
}

// A dir's cwd is IMMUTABLE: Claude derives the projects-dir name from the cwd, so every session in a dir
// shares one cwd. Cache the recovered ref (keyed by full dir path) so the 64KB head reads happen once
// instead of on every usage:report — which fires on each deck refresh. Positive-only: empty or
// no-cwd dirs cost ~0 to re-check (no .jsonl to read), and a dir written later must still be retried.
const _dirCache = new Map<string, ClaudeProjectRef>();
/** Test-only: reset the dir cache between tests so cross-test state can't leak. */
export function _clearClaudeDirCache(): void { _dirCache.clear(); }

/**
 * List the real { path, name } of every ~/.claude/projects dir, recovering each from a session's `cwd`
 * (the encoded dir name is lossy). Dirs with no recoverable cwd are skipped (can't be classified).
 * Async so it never blocks the main process (all IPC + cockpit PTY output share that thread); best-effort:
 * never throws — unreadable dirs/files are skipped.
 */
export async function listClaudeProjectDirs(claudeProjectsDir: string): Promise<ClaudeProjectRef[]> {
  let names: string[];
  try { names = (await readdir(claudeProjectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  const out: ClaudeProjectRef[] = [];
  for (const name of names) {
    const dir = join(claudeProjectsDir, name);
    const cached = _dirCache.get(dir);
    if (cached) { out.push(cached); continue; }
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let ref: ClaudeProjectRef | null = null;
    for (const f of files) {
      let head: string;
      try { head = await readHead(join(dir, f)); } catch { continue; }
      ref = recoverProjectFromLines(head.split('\n'));
      if (ref) break;
    }
    if (ref) { _dirCache.set(dir, ref); out.push(ref); }
  }
  return out;
}
