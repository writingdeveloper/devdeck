import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { firstUserMessage } from '../shared/sessionParse';

export interface SessionMeta {
  id: string;
  mtimeMs: number;
  firstMessage: string | null;
}

const HEAD_BYTES = 64 * 1024;

const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

function readHead(file: string): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  }
}

/** Sessions for a project, newest-first, with first-message previews. */
export function listSessions(
  projectPath: string,
  claudeProjectsDir: string,
  limit = 5,
): SessionMeta[] {
  const dir = join(claudeProjectsDir, encodeProjectPath(projectPath));
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    metas.push({ id, mtimeMs, firstMessage: null });
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = metas.slice(0, limit);
  for (const m of top) {
    m.firstMessage = firstUserMessage(readHead(join(dir, m.id + '.jsonl')));
  }
  return top;
}
