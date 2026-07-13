import {
  shouldIssue, verifyShutdownRecord, AUTO_COUNTDOWN_MS, MANUAL_COUNTDOWN_MS,
  type ShutdownPhase, type ShutdownRecord, type ShutdownSessionSummary,
} from '../shared/shutdownIdle';

export interface ShutdownStatus {
  phase: ShutdownPhase;
  lastBusyAt: number;
  scheduledAt: number | null; // epoch ms the OS will power off (countdown UI derives the remainder)
  kind: 'auto' | 'manual' | null;
}

export interface SchedulerDeps {
  log: { append(r: ShutdownRecord): boolean; updateLast(p: Partial<ShutdownRecord>): boolean };
  now(): number;
  /** spawn `shutdown /s /f /t <delaySec> /c ...` — the countdown is the OS's from here on. */
  execShutdown(delaySec: number): void;
  /** spawn `shutdown /a` */
  execAbort(): void;
  transcriptMtime(): Promise<number>;
  idleHoldMs(): number;
  onStatus(s: ShutdownStatus): void;
  onError(msg: string): void;
  /** setTimeout indirection so tests drive ticks manually. */
  schedule(fn: () => void, ms: number): void;
}

const TICK_MS = 30_000;

/**
 * One-shot idle-shutdown watcher. Three busy signals feed lastBusyAt: cockpit pty traffic
 * (noteBusy — a working agent's spinner keeps bytes flowing, and user keystrokes echo too, so a
 * present user always reads as busy), the renderer's computed working-session count (noteReport —
 * covers a working agent in a silent tool/think gap), and external transcript mtimes (covers
 * sessions running outside the cockpit entirely). Issuing = record first, then delegate the
 * countdown to the OS; cancel is only ever the user's explicit `shutdown /a`.
 */
export class ShutdownScheduler {
  private phase: ShutdownPhase = 'disarmed';
  private lastBusyAt: number;
  private scheduledAt: number | null = null;
  private kind: 'auto' | 'manual' | null = null;
  private workingCount = 0;
  private sessions: ShutdownSessionSummary[] = [];
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.lastBusyAt = deps.now();
  }

  /** Any cockpit pty output/input byte — cheap, called per chunk from the ipc layer. */
  noteBusy(): void {
    const n = this.deps.now();
    if (n > this.lastBusyAt) this.lastBusyAt = n;
  }

  /** Renderer's activity report: working-session count (busy while > 0) + record-ready session summary. */
  noteReport(working: number, sessions: ShutdownSessionSummary[]): void {
    this.workingCount = working;
    this.sessions = sessions;
    if (working > 0) this.noteBusy();
  }

  status(): ShutdownStatus {
    return { phase: this.phase, lastBusyAt: this.lastBusyAt, scheduledAt: this.scheduledAt, kind: this.kind };
  }

  arm(): void {
    if (this.phase !== 'disarmed') return; // countdown owns the OS timer; cancel first
    this.phase = 'armed';
    this.lastBusyAt = this.deps.now(); // idle time accrued BEFORE arming never counts
    this.push();
    this.tick();
  }

  disarm(): void {
    if (this.phase !== 'armed') return;
    this.phase = 'disarmed';
    this.push();
  }

  shutdownNow(): void {
    if (this.phase === 'countdown') return;
    this.issue('manual', MANUAL_COUNTDOWN_MS);
  }

  cancel(): void {
    if (this.phase !== 'countdown') return;
    this.deps.execAbort();
    this.deps.log.updateLast({ status: 'cancelled', cancelledAt: this.deps.now() });
    this.phase = 'disarmed'; // one-shot: a cancel fully disarms, re-arm is explicit
    this.scheduledAt = null;
    this.kind = null;
    this.push();
  }

  private push(): void { this.deps.onStatus(this.status()); }

  private issue(kind: 'auto' | 'manual', countdownMs: number): void {
    const at = this.deps.now();
    const rec: ShutdownRecord = {
      at, scheduledAt: at + countdownMs, kind, status: 'issued', sessions: this.sessions,
      ...(kind === 'auto' ? { idleMinutes: Math.round(this.deps.idleHoldMs() / 60_000) } : {}),
    };
    // Record-or-abort: "when did it shut down" must be answerable tomorrow, so a shutdown
    // without its on-disk record is worse than no shutdown at all.
    if (!this.deps.log.append(rec)) {
      this.deps.onError('DevDeck: shutdown record could not be written — shutdown aborted');
      this.phase = 'disarmed';
      this.push();
      return;
    }
    this.deps.execShutdown(Math.round(countdownMs / 1000));
    this.phase = 'countdown';
    this.scheduledAt = rec.scheduledAt;
    this.kind = kind;
    this.push();
  }

  private tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    const loop = async (): Promise<void> => {
      if (this.phase !== 'armed') { this.ticking = false; return; }
      try {
        // External transcripts: an mtime is busy evidence AT that moment, clamped to now
        // (a file dated in the future must not wedge the watcher open forever).
        const m = await this.deps.transcriptMtime();
        const clamped = Math.min(m, this.deps.now());
        if (clamped > this.lastBusyAt) this.lastBusyAt = clamped;
      } catch { /* best-effort signal — the other two still guard */ }
      if (this.workingCount > 0) this.noteBusy();
      if (this.phase === 'armed' && shouldIssue({ phase: this.phase, now: this.deps.now(), lastBusyAt: this.lastBusyAt, idleHoldMs: this.deps.idleHoldMs() })) {
        this.issue('auto', AUTO_COUNTDOWN_MS);
        this.ticking = false;
        return;
      }
      this.push(); // keeps the renderer chip's "last activity N min ago" fresh
      this.deps.schedule(() => void loop(), TICK_MS);
    };
    void loop();
  }
}

/**
 * Next-boot banner input: the newest record, only if it was an un-acknowledged ISSUED one,
 * with the uptime-derived verdict on whether the machine really did go down.
 */
export function pendingBootBanner(
  records: ShutdownRecord[], bootTimeMs: number,
): { record: ShutdownRecord; verdict: 'confirmed' | 'not-executed' } | null {
  const last = records[records.length - 1];
  if (!last || last.acknowledged || last.status !== 'issued') return null;
  return { record: last, verdict: verifyShutdownRecord(last, bootTimeMs) };
}
