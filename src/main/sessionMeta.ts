import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import {
  advanceSessionMeta, emptySessionMetaState, finalizeSessionMeta,
  type ParsedSessionMeta, type SessionMetaState,
} from '../shared/sessionMeta';
import { isValidSessionId } from './sessions';

/** Parsed meta plus the log's mtime — the cache key for the AI summary and the task-staleness reference. */
export type ClaudeSessionMeta = ParsedSessionMeta & { mtimeMs: number };

/** What every failure path returns: a well-formed meta that says "nothing known". */
export function emptySessionMeta(): ClaudeSessionMeta {
  return { model: null, activeMs: 0, contextTokens: 0, assistantText: null, editedFiles: [], userText: null, mtimeMs: 0 };
}

/** Read granularity. Peak memory is this plus the longest single line, not the file. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Per-session parse state, resumed across reads. `offset` is the byte just past the last COMPLETE line
 * consumed so far, so an append-only log is only ever read forward — the cockpit's 30s tick on an
 * active session costs the few KB that turn wrote, not the whole log again.
 */
const _metaCache = new Map<string, { mtimeMs: number; offset: number; state: SessionMetaState; meta: ClaudeSessionMeta }>();

/**
 * Fold a log's bytes from `start` into `state`, stopping at the last complete line.
 * Returns the byte offset just past it (what the next read should start from).
 *
 * Chunked on purpose. `readFileSync(file, 'utf8')` was the old shape and it does not survive real
 * sessions: Node's maximum string is 512 MiB, and a 547 MiB transcript on this machine threw
 * ERR_STRING_TOO_LONG — which the caller swallowed, so that session silently showed no model, no
 * context %, no summary and no active time, while retrying the same 420 ms blocking read every tick.
 * Even well under the limit it was expensive: 183 MiB cost 326 ms and 410 MB of RSS.
 *
 * The chunk boundary is found in the BYTES, not in decoded text, so a multi-byte character split
 * across two reads is never decoded in halves.
 */
function foldFrom(fd: number, start: number, size: number, state: SessionMetaState): number {
  let pos = start;
  let carry = Buffer.alloc(0); // bytes after the last newline seen — an incomplete line
  while (pos < size) {
    const want = Math.min(CHUNK_BYTES, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const n = readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    pos += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const nl = data.lastIndexOf(NEWLINE);
    if (nl < 0) { carry = Buffer.from(data); continue; } // one line longer than a chunk — keep reading
    advanceSessionMeta(state, data.subarray(0, nl).toString('utf8'));
    carry = Buffer.from(data.subarray(nl + 1));
  }
  return pos - carry.length; // the trailing partial line is NOT consumed — it may still be being written
}

/** Read a Claude session's meta from its on-disk .jsonl (best-effort; an empty meta if missing). */
export function readClaudeSessionMeta(projectPath: string, sessionId: string, claudeProjectsDir: string): ClaudeSessionMeta {
  // Guard the id before it touches a path — a crafted sessionId must not escape ~/.claude/projects (path traversal).
  if (!isValidSessionId(sessionId)) return emptySessionMeta();
  const file = join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
  let mtimeMs: number;
  let size: number;
  try { ({ mtimeMs, size } = statSync(file)); } catch { return emptySessionMeta(); }
  const cached = _metaCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta; // unchanged log → skip the read entirely

  // Resume where the last read stopped, but only if the file still STARTS the same way. A log that
  // shrank was rewritten, not appended to, and the state carried over would describe a file that is
  // no longer there — reparse from zero.
  const resume = cached && size >= cached.offset;
  const state = resume ? cached.state : emptySessionMetaState();
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return emptySessionMeta(); }
  let offset: number;
  try {
    offset = foldFrom(fd, resume ? cached.offset : 0, size, state);
  } catch {
    return emptySessionMeta(); // leave the cache alone: a later read can still resume from it
  } finally {
    try { closeSync(fd); } catch { /* already gone */ }
  }
  const meta = { ...finalizeSessionMeta(state), mtimeMs };
  _metaCache.set(file, { mtimeMs, offset, state, meta });
  return meta;
}
