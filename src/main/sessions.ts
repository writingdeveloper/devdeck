import { existsSync } from 'node:fs';
import { readdir, stat, open, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectPath, SESSION_ID_RE, isValidSessionId } from '../shared/paths';
import { firstUserMessage, lastUserMessage } from '../shared/sessionParse';

export interface SessionMeta {
  id: string;
  mtimeMs: number;
  firstMessage: string | null;
}

const HEAD_BYTES = 64 * 1024;
// Sessions can be tens of MB and a single autonomous turn after the user's last
// prompt can itself be multiple MB, so read the tail backward in chunks and stop
// as soon as a genuine user message is found, up to a hard cap.
const TAIL_CHUNK = 1024 * 1024;
const TAIL_MAX = 8 * 1024 * 1024;

// SESSION_ID_RE + isValidSessionId now live in shared/paths (single source of truth); re-export the
// latter so sessionMeta.ts's `import { isValidSessionId } from './sessions'` keeps working unchanged.
export { isValidSessionId };

async function readHead(file: string): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    try { return await readFile(file, 'utf8'); } catch { return ''; }
  } finally {
    await handle?.close().catch(() => { /* already gone */ });
  }
}

/** Sessions for a project, newest-first, with first-message previews. Async so the deck's per-project
 *  scan (readdir + head reads for many projects, every ~45s + on focus) never blocks the main thread. */
export async function listSessions(
  projectPath: string,
  claudeProjectsDir: string,
  limit = 5,
): Promise<SessionMeta[]> {
  const dir = join(claudeProjectsDir, encodeProjectPath(projectPath));
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      metas.push({ id, mtimeMs: (await stat(join(dir, name))).mtimeMs, firstMessage: null });
    } catch {
      continue;
    }
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = metas.slice(0, limit);
  for (const m of top) {
    m.firstMessage = firstUserMessage(await readHead(join(dir, m.id + '.jsonl')));
  }
  return top;
}

interface SessionFileStat { id: string; mtimeMs: number; birthtimeMs: number }

/**
 * The project's session files with their stat, in directory order.
 *
 * Async on purpose. This runs on the cockpit's slow tick for EVERY open tile (drift detection) and for
 * the restore list's existence check, and the old readdirSync + statSync-per-file form held the main
 * thread for the whole listing each time — ~1.5 ms for a 150-session project on this machine, times
 * eleven tiles, every tick, and much worse on a slow or cloud-synced disk. The stats now go out
 * together, so the wall time is about one round-trip rather than one per file.
 */
async function sessionFileStats(projectPath: string, claudeProjectsDir: string): Promise<SessionFileStat[]> {
  const dir = join(claudeProjectsDir, encodeProjectPath(projectPath));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no session dir for this project (or unreadable) — what the old existsSync guard answered
  }
  const ids = names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .filter((id) => SESSION_ID_RE.test(id));
  const rows = await Promise.all(ids.map(async (id): Promise<SessionFileStat | null> => {
    try {
      const st = await stat(join(dir, id + '.jsonl'));
      return { id, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
    } catch {
      return null; // vanished between the listing and the stat
    }
  }));
  return rows.filter((row): row is SessionFileStat => row !== null);
}

/**
 * ALL of a project's on-disk session ids, mtime-desc — cheap (no head-read for first messages, no
 * limit), for the cockpit restore resolver which must recognize an older-but-valid saved id as still
 * existing (listSessions caps at 5, which would hide it and force a wrong newest fallback).
 */
/** How many sessions a project has: one directory listing, no stat and no reads. */
export async function countSessionFiles(projectPath: string, claudeProjectsDir: string): Promise<number> {
  try {
    const names = await readdir(join(claudeProjectsDir, encodeProjectPath(projectPath)));
    return names.filter((name) => name.endsWith('.jsonl') && SESSION_ID_RE.test(name.slice(0, -'.jsonl'.length))).length;
  } catch { return 0; }
}

export async function listSessionIds(projectPath: string, claudeProjectsDir: string): Promise<string[]> {
  const rows = await sessionFileStats(projectPath, claudeProjectsDir);
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs); // stable: equal mtimes keep directory order, as before
  return rows.map((r) => r.id);
}

/**
 * Every on-disk session's id + mtime + birthtime for one project — the live drift detector's input
 * (pickDriftedSessionId): birthtime tells "was this file born after the tile opened" (/clear creates
 * a brand-new file), mtime tells "was it written since the last check". Deliberately not cached:
 * "written since the last check" is the whole question, and an answer from a moment ago is wrong.
 */
export function listSessionStats(projectPath: string, claudeProjectsDir: string): Promise<SessionFileStat[]> {
  return sessionFileStats(projectPath, claudeProjectsDir);
}

/**
 * Last genuine user message of a session, found by scanning the file backward in
 * chunks (so a multi-MB trailing assistant turn doesn't hide it) up to TAIL_MAX.
 * Null if absent/unreadable or no user message within the cap.
 */
export async function lastUserMessageForSession(
  projectPath: string,
  sessionId: string,
  claudeProjectsDir: string,
): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const file = join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
  return cachedTailAnswer(file, (handle, size) => findInTail(handle, size, TAIL_MAX, TAIL_CHUNK, lastUserMessage));
}

/**
 * Search a file's tail backward for the LAST line `find` recognizes, `chunkBytes` per read, at most
 * `maxBytes` from the end. `find` gets a run of complete lines and answers with the last match in it.
 *
 * Each read hands `find` ONLY the lines that read completed. The loop this replaces re-decoded and
 * re-parsed the whole accumulated tail on every step — 1 MB, then 2 MB, … then 8 MB: ~36 MB of
 * decoding and JSON.parse to search 8 MB — and the Codex copy of it did that with readSync, holding
 * the main thread ~45 ms per call on a rollout whose last prompt was far back. Searching only the new
 * lines gives the same answer: the lines already searched held no match (or we would have returned),
 * so the last match overall is the last match among the new ones.
 *
 * `carry` is the leading partial line, whose start is in bytes not read yet; it rides along until the
 * read that reaches its beginning. Cutting at a newline BYTE never splits a multi-byte character.
 */
export async function findInTail(
  handle: FileHandle, size: number, maxBytes: number, chunkBytes: number,
  find: (completeLines: string) => string | null,
): Promise<string | null> {
  let pos = size;
  let carry = Buffer.alloc(0);
  while (pos > 0 && size - pos < maxBytes) {
    const length = Math.min(chunkBytes, pos);
    pos -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, pos);
    const read = chunk.subarray(0, bytesRead);
    const data = carry.length ? Buffer.concat([read, carry]) : read;
    if (pos === 0) return find(data.toString('utf8')); // reached the start: the first line is whole too
    const newline = data.indexOf(0x0a);
    if (newline < 0) { carry = data; continue; } // one line longer than everything read so far
    const found = find(data.toString('utf8', newline + 1));
    if (found) return found;
    carry = data.subarray(0, newline + 1);
  }
  return null;
}

/**
 * Answers already found, by file. The deck asks for every project's resume cue on each refresh — every
 * ~45 s and on every window focus — and a session nobody is typing in can only give the answer it gave
 * last time. Keyed on size AND mtime: an append changes both.
 */
const _tailAnswers = new Map<string, { size: number; mtimeMs: number; value: string | null }>();
/** One entry per session ever asked about — a handful per project. This only bounds a pathological case. */
const TAIL_ANSWERS_MAX = 2000;
/** Test-only: forget cached tail answers. */
export function _clearTailAnswerCache(): void { _tailAnswers.clear(); }

/**
 * `read` the file, or answer from the cache when it has not changed since the last read. Shared by
 * the Claude and Codex resume-cue readers, which differ only in how a user line is recognized.
 */
export async function cachedTailAnswer(file: string, read: (handle: FileHandle, size: number) => Promise<string | null>): Promise<string | null> {
  let size: number;
  let mtimeMs: number;
  try { ({ size, mtimeMs } = await stat(file)); } catch { return null; }
  const hit = _tailAnswers.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.value;
  let handle: FileHandle;
  try { handle = await open(file, 'r'); } catch { return null; }
  try {
    const value = await read(handle, size);
    if (_tailAnswers.size >= TAIL_ANSWERS_MAX) _tailAnswers.clear();
    _tailAnswers.set(file, { size, mtimeMs, value });
    return value;
  } catch {
    return null; // not remembered: a failed read says nothing about the file
  } finally {
    await handle.close().catch(() => { /* already gone */ });
  }
}
