import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta } from '../shared/types';
import { codexCwd, codexFirstUserMessage, codexLastUserMessage } from '../shared/codexParse';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

function readHead(file: string): string {
  try {
    const fd = openSync(file, 'r');
    try { const buf = Buffer.alloc(HEAD_BYTES); const n = readSync(fd, buf, 0, HEAD_BYTES, 0); return buf.toString('utf8', 0, n); }
    finally { closeSync(fd); }
  } catch { try { return readFileSync(file, 'utf8'); } catch { return ''; } }
}
function readTail(file: string, bytes: number): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = statSync(file).size; const start = Math.max(0, size - bytes); const len = size - start;
      const buf = Buffer.alloc(len); const n = readSync(fd, buf, 0, len, start); return buf.toString('utf8', 0, n);
    } finally { closeSync(fd); }
  } catch { try { return readFileSync(file, 'utf8'); } catch { return ''; } }
}

/** Recursively collect rollout-*.jsonl files under the sessions dir. */
function rolloutFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...rolloutFiles(full));
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

interface CodexHead { id: string | null; cwd: string | null; mtimeMs: number; path: string; }
const _headCache = new Map<string, CodexHead>(); // key: path + ':' + mtimeMs

function head(file: string): CodexHead {
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const key = file + ':' + mtimeMs;
  const cached = _headCache.get(key);
  if (cached) return cached;
  const text = readHead(file);
  const metaLine = text.split('\n', 1)[0] ?? '';
  let id: string | null = null;
  try { id = (JSON.parse(metaLine)?.payload?.id ?? null) as string | null; } catch { /* ignore */ }
  const h: CodexHead = { id, cwd: codexCwd(text), mtimeMs, path: file };
  _headCache.set(key, h);
  return h;
}

export function codexAvailable(codexSessionsDir: string): boolean {
  return existsSync(codexSessionsDir);
}

/** Codex sessions for a project (by cwd), newest-first, with first-message previews. */
export function listCodexSessions(projectPath: string, codexSessionsDir: string, limit = 5): SessionMeta[] {
  const matches = rolloutFiles(codexSessionsDir)
    .map(head)
    .filter((h) => h.cwd === projectPath && h.id)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  return matches.map((h) => ({
    id: h.id as string,
    mtimeMs: h.mtimeMs,
    firstMessage: codexFirstUserMessage(readHead(h.path)),
  }));
}

/** Last user message of a specific Codex session (by id, under a cwd). Null if absent. */
export function lastUserMessageForCodexSession(projectPath: string, sessionId: string, codexSessionsDir: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const match = rolloutFiles(codexSessionsDir).map(head).find((h) => h.id === sessionId && h.cwd === projectPath);
  if (!match) return null;
  return codexLastUserMessage(readTail(match.path, TAIL_BYTES));
}
