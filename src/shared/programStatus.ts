// src/shared/programStatus.ts
// Claude Code's own report of what it is doing (OSC 7501, "program status"), read instead of guessed.
//
// Claude Code asks the terminal `ESC ] 7501 ; ? BEL` while it starts. A terminal that answers in kind
// is then sent `ESC ] 7501 ; state=<s>:app=claude-code[:kind=<k>][:progress=<n>][:msg=<base64>] BEL`
// whenever the session's state changes (read from Claude Code 2.1.306, and observed live):
//   working            a turn is running (progress, and what it is doing, when known)
//   blocked + kind     it is waiting on the person: permission | question | auth (or none, a dialog)
//   done               the turn finished; msg says what it did
//   idle               nothing has run yet, or the turn was stopped
//   error              the turn failed; msg says why
// Entries with an `id` are background tasks inside the session, not the session itself.
import type { ActivityState } from './sessionStatus';

export type ProgramState = 'working' | 'blocked' | 'done' | 'idle' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatus {
  state: ProgramState;
  kind: BlockedKind | null;
  /** 0..100 when the agent knows how far along it is. */
  progress: number | null;
  /** One line from the agent: what it is doing, what it did, or why it stopped. */
  msg: string | null;
}

/** The probe Claude Code sends; answered on the host, once, the moment it is seen. */
export const PROGRAM_STATUS_PROBE = '\x1b]7501;?\x07';
const PROBE_RE = /\x1b\]7501;\?(?:\x07|\x1b\\)/;
/** The answer: an OSC 7501 that starts with `?` is all Claude Code checks for. */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?\x07';
const STATES = new Set<ProgramState>(['working', 'blocked', 'done', 'idle', 'error']);
const KINDS = new Set<BlockedKind>(['permission', 'question', 'auth']);
const MSG_MAX = 300;

/** Whether `text` holds the probe. */
export function hasProgramStatusProbe(text: string): boolean {
  return text.includes('7501;?') && PROBE_RE.test(text);
}

/**
 * The session's own status from the payload of one OSC 7501 (everything after `7501;`). Null for a
 * background task's entry, a probe, a `clear`, or anything malformed.
 */
export function parseProgramStatus(payload: string): ProgramStatus | null {
  if (!payload || payload.startsWith('?')) return null;
  const fields = new Map<string, string>();
  for (const part of payload.split(':')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (fields.has('id')) return null;
  const state = fields.get('state') as ProgramState | undefined;
  if (!state || !STATES.has(state)) return null;
  const app = fields.get('app');
  if (app !== undefined && app !== 'claude-code') return null;
  const kind = fields.get('kind') as BlockedKind | undefined;
  const p = Number(fields.get('progress'));
  return {
    state,
    kind: state === 'blocked' && kind && KINDS.has(kind) ? kind : null,
    progress: fields.has('progress') && Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : null,
    msg: decodeMsg(fields.get('msg')),
  };
}

function decodeMsg(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, MSG_MAX) : null;
  } catch { return null; }
}

/**
 * The sidebar's activity from the agent's own status. A finished turn reads as "your turn" until it
 * has sat for `idleMs`, the same window the screen-based guess uses.
 */
export function activityFromProgramStatus(s: ProgramStatus, sinceMs: number, nowMs: number, idleMs: number): ActivityState {
  switch (s.state) {
    case 'working': return 'working';
    case 'blocked': return 'attention';
    default: return nowMs - sinceMs < idleMs ? 'turn' : 'idle';
  }
}
