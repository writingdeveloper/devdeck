import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { parseSessionMeta, type ParsedSessionMeta } from '../shared/sessionMeta';
import { isValidSessionId } from './sessions';

/** Parsed meta plus the log's mtime — the cache key for the AI summary and the task-staleness reference. */
export type ClaudeSessionMeta = ParsedSessionMeta & { mtimeMs: number };

/** What every failure path returns: a well-formed meta that says "nothing known". */
export function emptySessionMeta(): ClaudeSessionMeta {
  return { model: null, activeMs: 0, contextTokens: 0, assistantText: null, editedFiles: [], userText: null, mtimeMs: 0 };
}

// Cache one { mtime, meta } per session-log path. The cockpit's 30s tick re-reads every session's
// meta; without this it re-read + re-parsed the full (often multi-MB) jsonl each tick even when the
// log hadn't changed. Keyed by path (not path+mtime), so the map size is bounded by the number of
// distinct sessions — a modified log is re-read, a static one returns the cached parse.
const _metaCache = new Map<string, { mtimeMs: number; meta: ClaudeSessionMeta }>();

/** Read a Claude session's meta from its on-disk .jsonl (best-effort; an empty meta if missing). */
export function readClaudeSessionMeta(projectPath: string, sessionId: string, claudeProjectsDir: string): ClaudeSessionMeta {
  // Guard the id before it touches a path — a crafted sessionId must not escape ~/.claude/projects (path traversal).
  if (!isValidSessionId(sessionId)) return emptySessionMeta();
  const file = join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return emptySessionMeta(); }
  const cached = _metaCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta; // unchanged log → skip the read + parse
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return emptySessionMeta(); }
  const meta = { ...parseSessionMeta(raw), mtimeMs };
  _metaCache.set(file, { mtimeMs, meta });
  return meta;
}
