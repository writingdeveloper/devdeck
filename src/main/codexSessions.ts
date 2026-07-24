import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta } from '../shared/types';
import { codexFirstUserMessage, codexLastUserMessage, codexSessionMeta } from '../shared/codexParse';
import { SESSION_ID_RE } from '../shared/paths';

const HEAD_BYTES = 64 * 1024;
const TAIL_CHUNK_BYTES = 1024 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

interface RolloutHead {
  file: string;
  id: string;
  mtimeMs: number;
  birthtimeMs: number;
  firstMessage: string | null;
}

function readHead(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* file disappeared */ }
    }
  }
}

/** Enumerate only rollout JSONL files, without recursively reading arbitrary files. */
function rolloutFiles(dir: string): string[] {
  const files: string[] = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
    }
  }
  return files;
}

function rolloutHeads(projectPath: string, dir: string): RolloutHead[] {
  if (!existsSync(dir)) return [];
  const heads: RolloutHead[] = [];
  for (const file of rolloutFiles(dir)) {
    const raw = readHead(file);
    if (raw === null) continue;
    const meta = codexSessionMeta(raw);
    // Match CWD exactly: a rollout for a similarly named project must never leak into this project.
    if (!meta || meta.cwd !== projectPath || !SESSION_ID_RE.test(meta.id)) continue;
    try {
      const { mtimeMs, birthtimeMs } = statSync(file);
      heads.push({ file, id: meta.id, mtimeMs, birthtimeMs, firstMessage: codexFirstUserMessage(raw) });
    } catch {
      // Concurrent cleanup can remove a rollout after the bounded head read.
    }
  }
  return heads;
}

function newestFirst<T extends { mtimeMs: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Codex stores rollout files under nested date directories. */
export function codexAvailable(dir: string): boolean {
  return existsSync(dir);
}

/** Matching Codex sessions, newest-first, using only a bounded 64 KiB read for each preview. */
export function listCodexSessions(projectPath: string, dir: string, limit = 5): SessionMeta[] {
  return newestFirst(rolloutHeads(projectPath, dir))
    .slice(0, Math.max(0, limit))
    .map(({ id, mtimeMs, firstMessage }) => ({ id, mtimeMs, firstMessage }));
}

/** Every matching on-disk session id, newest-first, for restore resolution. */
export function listCodexSessionIds(projectPath: string, dir: string): string[] {
  return newestFirst(rolloutHeads(projectPath, dir)).map(({ id }) => id);
}

/** mtime and birthtime for matching sessions, used by live drift detection. */
export function listCodexSessionStats(projectPath: string, dir: string): { id: string; mtimeMs: number; birthtimeMs: number }[] {
  return newestFirst(rolloutHeads(projectPath, dir)).map(({ id, mtimeMs, birthtimeMs }) => ({ id, mtimeMs, birthtimeMs }));
}

/**
 * Find the last user message without trusting an id as a path component.  We locate a matching,
 * metadata-validated rollout first, then scan its final 8 MiB backward in bounded chunks.
 */
export function lastUserMessageForCodexSession(projectPath: string, id: string, dir: string): string | null {
  if (!SESSION_ID_RE.test(id)) return null;
  const file = rolloutHeads(projectPath, dir).find((head) => head.id === id)?.file;
  if (!file) return null;

  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    let position = size;
    let accumulated = Buffer.alloc(0);
    while (position > 0 && size - position < TAIL_MAX_BYTES) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      accumulated = Buffer.concat([chunk.subarray(0, bytesRead), accumulated]);
      const text = accumulated.toString('utf8');
      const firstNewline = text.indexOf('\n');
      const completeLines = position === 0 ? text : firstNewline < 0 ? '' : text.slice(firstNewline + 1);
      const message = codexLastUserMessage(completeLines);
      if (message) return message;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* file disappeared */ }
    }
  }
}
