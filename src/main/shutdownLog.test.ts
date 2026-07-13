import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShutdownLog } from './shutdownLog';
import type { ShutdownRecord } from '../shared/shutdownIdle';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-sdlog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

const rec = (at: number, status: ShutdownRecord['status'] = 'issued'): ShutdownRecord =>
  ({ at, scheduledAt: at + 60_000, kind: 'auto', sessions: [], status });

describe('ShutdownLog', () => {
  it('reads [] when the file is missing', () => {
    expect(new ShutdownLog(join(dir, 'shutdown-log.json')).read()).toEqual([]);
  });

  it('reads [] from a corrupt file instead of throwing', () => {
    const f = join(dir, 'shutdown-log.json');
    writeFileSync(f, '{not json', 'utf8');
    expect(new ShutdownLog(f).read()).toEqual([]);
  });

  it('append persists and read round-trips', () => {
    const log = new ShutdownLog(join(dir, 'shutdown-log.json'));
    expect(log.append(rec(1))).toBe(true);
    expect(log.append(rec(2))).toBe(true);
    expect(log.read().map((r) => r.at)).toEqual([1, 2]);
    // Written as real JSON on disk (the next-boot reader is a fresh process).
    expect(JSON.parse(readFileSync(join(dir, 'shutdown-log.json'), 'utf8'))).toHaveLength(2);
  });

  it('caps at the 50 most recent records', () => {
    const log = new ShutdownLog(join(dir, 'shutdown-log.json'));
    for (let i = 0; i < 55; i++) log.append(rec(i));
    const all = log.read();
    expect(all).toHaveLength(50);
    expect(all[0].at).toBe(5);
  });

  it('updateLast patches only the newest record', () => {
    const log = new ShutdownLog(join(dir, 'shutdown-log.json'));
    log.append(rec(1));
    log.append(rec(2));
    expect(log.updateLast({ status: 'cancelled', cancelledAt: 99 })).toBe(true);
    const all = log.read();
    expect(all[0].status).toBe('issued');
    expect(all[1]).toMatchObject({ at: 2, status: 'cancelled', cancelledAt: 99 });
  });

  it('updateLast on an empty log returns false', () => {
    expect(new ShutdownLog(join(dir, 'shutdown-log.json')).updateLast({ acknowledged: true })).toBe(false);
  });

  it('append returns false when the write fails (record-or-abort contract)', () => {
    // Point the log AT A DIRECTORY so writeFileSync fails deterministically on every OS.
    const log = new ShutdownLog(dir);
    expect(log.append(rec(1))).toBe(false);
  });
});
