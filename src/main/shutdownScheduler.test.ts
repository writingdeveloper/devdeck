import { describe, it, expect, vi } from 'vitest';
import { ShutdownScheduler, pendingBootBanner, type SchedulerDeps } from './shutdownScheduler';
import type { ShutdownRecord } from '../shared/shutdownIdle';

const HOLD = 10 * 60_000;

/** Deterministic harness: manual clock + captured 30s ticks we fire by hand. */
function makeHarness(over: Partial<SchedulerDeps> = {}) {
  let now = 1_000_000;
  const ticks: Array<() => void> = [];
  const records: ShutdownRecord[] = [];
  const deps: SchedulerDeps = {
    log: {
      append: vi.fn((r: ShutdownRecord) => { records.push(r); return true; }),
      updateLast: vi.fn((p) => { Object.assign(records[records.length - 1] ?? {}, p); return records.length > 0; }),
    },
    now: () => now,
    execShutdown: vi.fn(),
    execAbort: vi.fn(),
    transcriptMtime: vi.fn(async () => 0),
    idleHoldMs: () => HOLD,
    onStatus: vi.fn(),
    onError: vi.fn(),
    schedule: (fn) => { ticks.push(fn); },
    ...over,
  };
  const s = new ShutdownScheduler(deps);
  return {
    s, deps, records,
    advance: (ms: number) => { now += ms; },
    // fire the most recently scheduled 30s tick and let its async body settle
    tick: async () => { const fn = ticks.pop(); ticks.length = 0; fn?.(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('ShutdownScheduler auto path', () => {
  it('arms, waits out the idle hold, then records + issues shutdown /t 60', async () => {
    const h = makeHarness();
    h.s.noteReport(0, [{ project: 'devdeck', activity: 'attention' }]);
    h.s.arm();
    expect(h.s.status().phase).toBe('armed');
    h.advance(HOLD + 1);
    await h.tick();
    expect(h.deps.log.append).toHaveBeenCalledTimes(1);
    expect(h.records[0]).toMatchObject({ kind: 'auto', status: 'issued', idleMinutes: 10, sessions: [{ project: 'devdeck', activity: 'attention' }] });
    expect(h.records[0].scheduledAt - h.records[0].at).toBe(60_000);
    expect(h.deps.execShutdown).toHaveBeenCalledWith(60);
    expect(h.s.status().phase).toBe('countdown');
  });

  it('arming resets lastBusyAt — idle time accrued BEFORE arming never counts', async () => {
    const h = makeHarness();
    h.advance(HOLD * 5); // a long quiet stretch before the user arms
    h.s.arm();
    h.advance(HOLD - 1);
    await h.tick();
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
  });

  it('cockpit pty traffic (noteBusy) defers the trigger', async () => {
    const h = makeHarness();
    h.s.arm();
    h.advance(HOLD - 1);
    h.s.noteBusy();
    h.advance(HOLD - 1);
    await h.tick();
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
    h.advance(2);
    await h.tick();
    expect(h.deps.execShutdown).toHaveBeenCalled();
  });

  it('a renderer-reported working session defers the trigger even with no pty bytes', async () => {
    const h = makeHarness();
    h.s.arm();
    h.s.noteReport(1, []);
    h.advance(HOLD + 1);
    await h.tick(); // tick sees workingCount>0 → refreshes lastBusyAt
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
    h.s.noteReport(0, []);
    h.advance(HOLD + 1);
    await h.tick();
    expect(h.deps.execShutdown).toHaveBeenCalled();
  });

  it('a fresh external transcript write defers the trigger', async () => {
    const h = makeHarness();
    h.s.arm();
    await h.tick(); // settle the arm-time pass FIRST (it already consumed the default 0-mtime mock)
    h.advance(HOLD + 1);
    vi.mocked(h.deps.transcriptMtime).mockResolvedValueOnce(h.deps.now() - 1000); // written 1s ago
    await h.tick();
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
  });

  it('a record write failure ABORTS the shutdown and reports the error', async () => {
    const h = makeHarness();
    vi.mocked(h.deps.log.append).mockReturnValue(false);
    h.s.arm();
    h.advance(HOLD + 1);
    await h.tick();
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
    expect(h.deps.onError).toHaveBeenCalled();
    expect(h.s.status().phase).toBe('disarmed'); // fail safe: don't keep silently re-trying
  });

  it('disarm stops the watcher; a later tick never fires', async () => {
    const h = makeHarness();
    h.s.arm();
    h.s.disarm();
    h.advance(HOLD + 1);
    await h.tick();
    expect(h.deps.execShutdown).not.toHaveBeenCalled();
    expect(h.s.status().phase).toBe('disarmed');
  });

  it('disarm during an in-flight tick ends the loop so a re-arm starts fresh (no 30s stall)', async () => {
    const h = makeHarness();
    h.s.arm();
    h.s.disarm();          // lands while the arm-time tick is suspended at transcriptMtime
    await h.tick();        // the suspended iteration resumes: must NOT reschedule a stale tick
    h.s.arm();             // re-arm must start its own loop immediately
    h.advance(HOLD + 1);
    await h.tick();
    expect(h.deps.execShutdown).toHaveBeenCalledTimes(1);
  });
});

describe('manual + cancel', () => {
  it('shutdownNow issues immediately with the 15s countdown, no arming needed', () => {
    const h = makeHarness();
    h.s.shutdownNow();
    expect(h.deps.execShutdown).toHaveBeenCalledWith(15);
    expect(h.records[0]).toMatchObject({ kind: 'manual', status: 'issued' });
    expect(h.records[0].idleMinutes).toBeUndefined();
    expect(h.s.status().phase).toBe('countdown');
  });

  it('cancel during countdown aborts via shutdown /a, records it, and fully disarms (one-shot)', () => {
    const h = makeHarness();
    h.s.shutdownNow();
    h.s.cancel();
    expect(h.deps.execAbort).toHaveBeenCalledTimes(1);
    expect(h.deps.log.updateLast).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(h.s.status()).toMatchObject({ phase: 'disarmed', scheduledAt: null, kind: null });
  });

  it('cancel outside a countdown is a no-op', () => {
    const h = makeHarness();
    h.s.cancel();
    expect(h.deps.execAbort).not.toHaveBeenCalled();
  });

  it('every phase change pushes a status snapshot', () => {
    const h = makeHarness();
    h.s.arm();
    h.s.disarm();
    h.s.shutdownNow();
    h.s.cancel();
    const phases = vi.mocked(h.deps.onStatus).mock.calls.map((c) => c[0].phase);
    expect(phases).toEqual(['armed', 'disarmed', 'countdown', 'disarmed']);
  });
});

describe('pendingBootBanner', () => {
  const issued: ShutdownRecord = { at: 5000, scheduledAt: 65_000, kind: 'auto', idleMinutes: 10, sessions: [], status: 'issued' };

  it('surfaces the newest unacknowledged issued record with its verdict', () => {
    expect(pendingBootBanner([issued], 100_000)).toEqual({ record: issued, verdict: 'confirmed' });
    expect(pendingBootBanner([issued], 30_000)).toEqual({ record: issued, verdict: 'not-executed' });
  });

  it('returns null for empty, acknowledged, or cancelled-last histories', () => {
    expect(pendingBootBanner([], 100_000)).toBeNull();
    expect(pendingBootBanner([{ ...issued, acknowledged: true }], 100_000)).toBeNull();
    expect(pendingBootBanner([{ ...issued, status: 'cancelled' }], 100_000)).toBeNull();
  });
});
