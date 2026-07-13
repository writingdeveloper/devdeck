import { readFileSync, writeFileSync } from 'node:fs';
import { sanitizeShutdownRecords, type ShutdownRecord } from '../shared/shutdownIdle';

/**
 * The idle-shutdown history file (userData/shutdown-log.json, newest last, capped at 50).
 * Every write reports success/failure because the caller's contract is record-or-abort:
 * a shutdown must never be issued without a verifiable on-disk record of it.
 */
export class ShutdownLog {
  constructor(private readonly filePath: string) {}

  read(): ShutdownRecord[] {
    try {
      return sanitizeShutdownRecords(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return []; // missing or corrupt — degrade to empty history, never crash
    }
  }

  private write(all: ShutdownRecord[]): boolean {
    try {
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Append + persist. `false` ⇒ the caller MUST NOT issue the shutdown. */
  append(r: ShutdownRecord): boolean {
    return this.write(sanitizeShutdownRecords([...this.read(), r]));
  }

  /** Patch the newest record in place (cancel / next-boot acknowledge). */
  updateLast(patch: Partial<ShutdownRecord>): boolean {
    const all = this.read();
    if (!all.length) return false;
    all[all.length - 1] = { ...all[all.length - 1], ...patch };
    return this.write(all);
  }
}
