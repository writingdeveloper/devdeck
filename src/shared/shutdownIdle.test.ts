import { describe, it, expect } from 'vitest';
import {
  shouldIssue, verifyShutdownRecord, sanitizeShutdownRecords,
  AUTO_COUNTDOWN_MS, MANUAL_COUNTDOWN_MS, DEFAULT_IDLE_HOLD_MINUTES, IDLE_HOLD_CHOICES,
  type ShutdownRecord,
} from './shutdownIdle';

const HOLD = 10 * 60_000;

describe('shouldIssue', () => {
  it('fires only when armed AND the idle hold has fully elapsed', () => {
    expect(shouldIssue({ phase: 'armed', now: 1000 + HOLD, lastBusyAt: 1000, idleHoldMs: HOLD })).toBe(true);
    expect(shouldIssue({ phase: 'armed', now: 1000 + HOLD - 1, lastBusyAt: 1000, idleHoldMs: HOLD })).toBe(false);
  });

  it('never fires when disarmed or already counting down', () => {
    expect(shouldIssue({ phase: 'disarmed', now: 1000 + HOLD, lastBusyAt: 1000, idleHoldMs: HOLD })).toBe(false);
    expect(shouldIssue({ phase: 'countdown', now: 1000 + HOLD, lastBusyAt: 1000, idleHoldMs: HOLD })).toBe(false);
  });
});

describe('verifyShutdownRecord', () => {
  const rec: ShutdownRecord = { at: 5000, scheduledAt: 65_000, kind: 'auto', sessions: [], status: 'issued' };
  it('confirms when the machine booted AFTER the scheduled shutdown moment', () => {
    expect(verifyShutdownRecord(rec, 100_000)).toBe('confirmed');
  });
  it('reports not-executed when the boot predates the scheduled moment (external abort / failure)', () => {
    expect(verifyShutdownRecord(rec, 30_000)).toBe('not-executed');
  });
});

describe('sanitizeShutdownRecords', () => {
  const good: ShutdownRecord = {
    at: 1, scheduledAt: 61_000, kind: 'auto', idleMinutes: 10,
    sessions: [{ project: 'devdeck', activity: 'turn' }], status: 'issued',
  };

  it('passes well-formed records through and drops junk entries', () => {
    const out = sanitizeShutdownRecords([good, null, 42, 'x', { at: 'nope' }, { ...good, kind: 'evil' }, { ...good, status: 'weird' }]);
    expect(out).toEqual([good]);
  });

  it('returns [] for a non-array (corrupt file)', () => {
    expect(sanitizeShutdownRecords(undefined)).toEqual([]);
    expect(sanitizeShutdownRecords({})).toEqual([]);
    expect(sanitizeShutdownRecords('[]')).toEqual([]);
  });

  it('drops malformed sessions inside a record and caps lengths', () => {
    const messy = { ...good, sessions: [{ project: 'ok', activity: 'working' }, { project: 7 }, null, { activity: 'turn' }] };
    const out = sanitizeShutdownRecords([messy]);
    expect(out[0].sessions).toEqual([{ project: 'ok', activity: 'working' }]);
    const many = { ...good, sessions: Array.from({ length: 80 }, (_, i) => ({ project: `p${i}`, activity: 'idle' })) };
    expect(sanitizeShutdownRecords([many])[0].sessions).toHaveLength(50);
  });

  it('keeps only the most recent 50 records', () => {
    const lots = Array.from({ length: 60 }, (_, i) => ({ ...good, at: i }));
    const out = sanitizeShutdownRecords(lots);
    expect(out).toHaveLength(50);
    expect(out[0].at).toBe(10);
    expect(out[49].at).toBe(59);
  });

  it('preserves optional fields (cancelledAt, acknowledged) and drops non-boolean acknowledged', () => {
    const c = { ...good, status: 'cancelled' as const, cancelledAt: 99, acknowledged: true };
    expect(sanitizeShutdownRecords([c])[0]).toEqual(c);
    const weird = { ...good, acknowledged: 'yes' };
    expect(sanitizeShutdownRecords([weird])[0].acknowledged).toBeUndefined();
  });
});

describe('constants', () => {
  it('locks the values the spec pins down', () => {
    expect(AUTO_COUNTDOWN_MS).toBe(60_000);
    expect(MANUAL_COUNTDOWN_MS).toBe(15_000);
    expect(DEFAULT_IDLE_HOLD_MINUTES).toBe(10);
    expect(IDLE_HOLD_CHOICES).toEqual([5, 10, 20, 30]);
  });
});
