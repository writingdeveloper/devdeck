import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionMeta } from '../shared/types';
import { extractCwdFromDbBuffer, firstUserMessageFromTranscript, lastUserMessageFromTranscript } from '../shared/antigravityParse';

const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

/** Antigravity (agy CLI + IDE) stores conversations under <dir>/conversations/<uuid>.db. */
export function antigravityAvailable(antigravityDir: string): boolean {
  return existsSync(join(antigravityDir, 'conversations'));
}

interface ConvHead { id: string; cwd: string | null; mtimeMs: number; }

function conversationHeads(antigravityDir: string): ConvHead[] {
  const convDir = join(antigravityDir, 'conversations');
  let entries;
  try { entries = readdirSync(convDir, { withFileTypes: true }); } catch { return []; }
  const out: ConvHead[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.db')) continue; // skip -wal / -shm
    const full = join(convDir, e.name);
    let mtimeMs = 0;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    let cwd: string | null = null;
    try { cwd = extractCwdFromDbBuffer(readFileSync(full)); } catch { /* unreadable — skip cwd */ }
    out.push({ id: e.name.slice(0, -3), cwd, mtimeMs });
  }
  return out;
}

function transcriptPath(antigravityDir: string, id: string): string {
  return join(antigravityDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

function readTranscript(antigravityDir: string, id: string): string | null {
  const p = transcriptPath(antigravityDir, id);
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; }
}

/** Antigravity sessions for a project (matched by cwd), newest-first, with first-message previews. */
export function listAntigravitySessions(projectPath: string, antigravityDir: string, limit = 5): SessionMeta[] {
  return conversationHeads(antigravityDir)
    .filter((h) => h.cwd && resolve(h.cwd) === resolve(projectPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((h) => {
      const tr = readTranscript(antigravityDir, h.id);
      return { id: h.id, mtimeMs: h.mtimeMs, firstMessage: tr ? firstUserMessageFromTranscript(tr) : null };
    });
}

/** Last user message of a specific Antigravity session (by id). Null when no transcript exists. */
export function lastUserMessageForAntigravitySession(projectPath: string, sessionId: string, antigravityDir: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const tr = readTranscript(antigravityDir, sessionId);
  return tr ? lastUserMessageFromTranscript(tr) : null;
}
