import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { recoverProjectFromLines, type ClaudeProjectRef } from '../shared/usageProjects';

const HEAD_BYTES = 65_536; // cwd appears within the first few lines — read only the head (session files can be MBs)

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally { closeSync(fd); }
}

/**
 * List the real { path, name } of every ~/.claude/projects dir, recovering each from a session's `cwd`
 * (the encoded dir name is lossy). Dirs with no recoverable cwd are skipped (can't be classified).
 * Best-effort: never throws — unreadable dirs/files are skipped.
 */
export function listClaudeProjectDirs(claudeProjectsDir: string): ClaudeProjectRef[] {
  let dirs: string[];
  try { dirs = readdirSync(claudeProjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  const out: ClaudeProjectRef[] = [];
  for (const d of dirs) {
    const dir = join(claudeProjectsDir, d);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let ref: ClaudeProjectRef | null = null;
    for (const f of files) {
      let head: string;
      try { head = readHead(join(dir, f)); } catch { continue; }
      ref = recoverProjectFromLines(head.split('\n'));
      if (ref) break;
    }
    if (ref) out.push(ref);
  }
  return out;
}
