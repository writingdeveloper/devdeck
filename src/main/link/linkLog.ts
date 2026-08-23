/**
 * The link audit log (userData/link-log.json, newest last).
 *
 * A machine that accepts remote connections owes its owner an answer to "who has been in here". The
 * connection list in Settings only shows what is connected right now; this is what shows that
 * something connected at 3am, that a device was refused, or that a call was denied for lack of a
 * permission. It is the difference between a feature you can audit and one you have to trust.
 *
 * Best-effort by design: a log write that fails must never stop a legitimate connection. That is the
 * opposite of ShutdownLog's record-or-abort contract, because the risk is opposite too — an
 * unrecorded shutdown loses work, while an unrecorded connection loses a line of history.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { HostLogEntry } from './hostServer';

/** Newest entries win when the cap is hit; a full log must never stop recording new events. */
const MAX_ENTRIES = 500;

export function sanitizeLinkLog(raw: unknown): HostLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(['connected', 'disconnected', 'paired', 'rejected', 'denied']);
  const out: HostLogEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.kind !== 'string' || !kinds.has(row.kind)) continue;
    if (typeof row.at !== 'number' || !Number.isFinite(row.at)) continue;
    out.push({
      at: row.at,
      kind: row.kind as HostLogEntry['kind'],
      machineName: typeof row.machineName === 'string' ? row.machineName.slice(0, 60) : '',
      fingerprint: typeof row.fingerprint === 'string' ? row.fingerprint.slice(0, 95) : '',
      detail: typeof row.detail === 'string' ? row.detail.slice(0, 200) : '',
    });
  }
  return out.slice(-MAX_ENTRIES);
}

export class LinkLog {
  /** Buffered so a burst of denials does not become a burst of synchronous file writes. */
  private pending: HostLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly schedule: (fn: () => void, ms: number) => NodeJS.Timeout = (fn, ms) => setTimeout(fn, ms),
  ) {}

  read(): HostLogEntry[] {
    try {
      return sanitizeLinkLog(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return []; // missing or corrupt — an unreadable log is empty history, never a crash
    }
  }

  /**
   * Record an event. Returns immediately; the write is coalesced.
   *
   * A denied device retrying in a loop would otherwise turn every rejection into a synchronous
   * rewrite of the whole file on the main process's thread — which is the thread serving every live
   * terminal.
   */
  append(entry: HostLogEntry): void {
    this.pending.push(entry);
    if (this.flushTimer) return;
    this.flushTimer = this.schedule(() => { this.flushTimer = null; this.flush(); }, 1_000);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const merged = sanitizeLinkLog([...this.read(), ...this.pending]);
    this.pending = [];
    try {
      writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf8');
    } catch {
      // Best-effort: losing a history line must never break a working connection.
    }
  }

  /** Newest first, for the Settings list. */
  recent(limit = 100): HostLogEntry[] {
    this.flush();
    return this.read().slice(-limit).reverse();
  }

  clear(): void {
    this.pending = [];
    try { writeFileSync(this.filePath, '[]', 'utf8'); } catch { /* best effort */ }
  }
}
