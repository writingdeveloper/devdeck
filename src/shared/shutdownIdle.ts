// Pure decision logic for the one-shot idle-shutdown feature ("🌙 종료 예약"):
// when to issue the OS shutdown, how to sanitize on-disk records, and how to
// verify on the NEXT boot that the shutdown actually happened. Side-effects
// (spawning shutdown.exe, file IO, timers) live in src/main/shutdownScheduler.ts.

export type ShutdownPhase = 'disarmed' | 'armed' | 'countdown';

export interface ShutdownSessionSummary { project: string; activity: string }

export interface ShutdownRecord {
  at: number;                // when the shutdown command was issued (epoch ms)
  scheduledAt: number;       // at + countdown — the moment the OS will power off
  kind: 'auto' | 'manual';
  idleMinutes?: number;      // auto only: the idle hold that triggered it
  sessions: ShutdownSessionSummary[]; // what was on the deck at issue time (incl. any attention-pending)
  status: 'issued' | 'cancelled';
  cancelledAt?: number;
  acknowledged?: boolean;    // next-boot banner shown and dismissed
}

// The countdown is delegated to the OS (`shutdown /s /f /t N`) at issue time, so a DevDeck
// crash mid-countdown cannot lose the shutdown — cancel is the explicit `shutdown /a` only.
export const AUTO_COUNTDOWN_MS = 60_000;
export const MANUAL_COUNTDOWN_MS = 15_000;
export const DEFAULT_IDLE_HOLD_MINUTES = 10;
export const IDLE_HOLD_CHOICES: readonly number[] = [5, 10, 20, 30];

/** True when an armed watcher has seen every busy signal quiet for the full idle hold. */
export function shouldIssue(i: { phase: ShutdownPhase; now: number; lastBusyAt: number; idleHoldMs: number }): boolean {
  return i.phase === 'armed' && i.now - i.lastBusyAt >= i.idleHoldMs;
}

/**
 * Did the shutdown actually happen? The next boot's start time (now - os.uptime()) must be LATER
 * than the scheduled power-off moment; an earlier boot time means this same OS session survived it
 * (external `shutdown /a`, or the command failed) — report that honestly instead of claiming success.
 */
export function verifyShutdownRecord(r: ShutdownRecord, bootTimeMs: number): 'confirmed' | 'not-executed' {
  return bootTimeMs > r.scheduledAt ? 'confirmed' : 'not-executed';
}

const MAX_RECORDS = 50;
const MAX_SESSIONS = 50;

function sanitizeSessions(v: unknown): ShutdownSessionSummary[] {
  if (!Array.isArray(v)) return [];
  const out: ShutdownSessionSummary[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o.project !== 'string' || typeof o.activity !== 'string') continue;
    out.push({ project: o.project.slice(0, 500), activity: o.activity.slice(0, 20) });
    if (out.length >= MAX_SESSIONS) break;
  }
  return out;
}

/** Defensive parse for shutdown-log.json — a corrupt/tampered file degrades to fewer records, never a crash. */
export function sanitizeShutdownRecords(v: unknown): ShutdownRecord[] {
  if (!Array.isArray(v)) return [];
  const out: ShutdownRecord[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.at !== 'number' || typeof o.scheduledAt !== 'number') continue;
    if (o.kind !== 'auto' && o.kind !== 'manual') continue;
    if (o.status !== 'issued' && o.status !== 'cancelled') continue;
    const rec: ShutdownRecord = { at: o.at, scheduledAt: o.scheduledAt, kind: o.kind, status: o.status, sessions: sanitizeSessions(o.sessions) };
    if (typeof o.idleMinutes === 'number') rec.idleMinutes = o.idleMinutes;
    if (typeof o.cancelledAt === 'number') rec.cancelledAt = o.cancelledAt;
    if (o.acknowledged === true) rec.acknowledged = true;
    out.push(rec);
  }
  return out.slice(-MAX_RECORDS);
}
