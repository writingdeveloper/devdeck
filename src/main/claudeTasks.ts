import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidSessionId } from '../shared/paths';

/**
 * Claude Code's own task list for a session lives in ~/.claude/tasks/<sessionId>/<n>.json, one small
 * file per task with { subject, activeForm, status }. The in-progress entry's `activeForm` ("Play
 * Console 배포 중") is the single best answer to "what is this session doing right now" — when it
 * exists. Not every session uses the task tools, so this is one source among several (see
 * shared/sessionSummary.ts for the priority ladder).
 */

/** Directory listings are tiny (a handful of tasks); this only bounds a pathological case. */
const MAX_FILES = 50;

/**
 * How far the task file may lag the session log before we stop believing it. A session that quit with
 * an unfinished task leaves `in_progress` on disk forever — resuming it would then show a label from
 * days ago as if it were live. Two hours is well past any single task's write cadence.
 */
export const TASK_STALE_MS = 2 * 60 * 60 * 1000;

interface TaskFile { subject?: unknown; activeForm?: unknown; status?: unknown }

/** Numeric-aware order so 2.json sorts before 10.json (the ids are sequential integers). */
function byNumber(a: string, b: string): number {
  const n = (s: string) => { const v = parseInt(s, 10); return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER; };
  return n(a) - n(b) || a.localeCompare(b);
}

/**
 * The `activeForm` (else `subject`) of this session's in-progress task, or null when there is none,
 * the session never used the task tools, or the file is too stale to trust.
 * `logMtimeMs` is the session .jsonl's mtime — the reference for staleness (0 = unknown, use `now`).
 */
export function readActiveTaskForm(
  sessionId: string,
  tasksDir: string,
  logMtimeMs = 0,
  now = Date.now(),
): string | null {
  // Guard before the id touches a path — a crafted id must not escape ~/.claude/tasks.
  if (!isValidSessionId(sessionId)) return null;
  const dir = join(tasksDir, sessionId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(byNumber).slice(0, MAX_FILES);
  } catch {
    return null; // no task list for this session
  }
  const reference = logMtimeMs > 0 ? logMtimeMs : now;
  for (const name of names) {
    const file = join(dir, name);
    let task: TaskFile;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
      task = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // unreadable / half-written file — skip it, not the whole list
    }
    if (!task || typeof task !== 'object' || task.status !== 'in_progress') continue;
    if (reference - mtimeMs > TASK_STALE_MS) continue; // left over from an abandoned run
    const label = (typeof task.activeForm === 'string' && task.activeForm.trim())
      || (typeof task.subject === 'string' && task.subject.trim())
      || '';
    if (label) return label;
  }
  return null;
}
