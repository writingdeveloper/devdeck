import { readdirSync, statSync, existsSync } from 'node:fs';
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
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

const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

/** A session id is safe to interpolate into a `claude -r <id>` command only if it matches this. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

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

/**
 * ALL of a project's on-disk session ids, mtime-desc — cheap (no head-read for first messages, no
 * limit), for the cockpit restore resolver which must recognize an older-but-valid saved id as still
 * existing (listSessions caps at 5, which would hide it and force a wrong newest fallback).
 */
export function listSessionIds(projectPath: string, claudeProjectsDir: string): string[] {
  const dir = join(claudeProjectsDir, encodeProjectPath(projectPath));
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: { id: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      rows.push({ id, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      continue;
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.map((r) => r.id);
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
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    let pos = size;
    let acc = Buffer.alloc(0);
    while (pos > 0 && size - pos < TAIL_MAX) {
      const readLen = Math.min(TAIL_CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, pos);
      acc = Buffer.concat([buf, acc]); // contiguous byte range [pos, size) — safe to decode whole
      const text = acc.toString('utf8');
      // Drop the leading partial line until we've read the very start of the file.
      const body = pos === 0 ? text : text.slice(text.indexOf('\n') + 1);
      const found = lastUserMessage(body);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => { /* already gone */ });
  }
}
