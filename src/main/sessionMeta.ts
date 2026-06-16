import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { parseSessionMeta } from '../shared/sessionMeta';
import { isValidSessionId } from './sessions';

/** Read a Claude session's { model, activeMs } from its on-disk .jsonl (best-effort; {null,0} if missing). */
export function readClaudeSessionMeta(projectPath: string, sessionId: string, claudeProjectsDir: string): { model: string | null; activeMs: number } {
  // Guard the id before it touches a path — a crafted sessionId must not escape ~/.claude/projects (path traversal).
  if (!isValidSessionId(sessionId)) return { model: null, activeMs: 0 };
  const file = join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return { model: null, activeMs: 0 }; }
  return parseSessionMeta(raw);
}
