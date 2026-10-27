import { describe, expect, it } from 'vitest';
import { agentProbeDue, backgroundPollDue, gitRefreshDue, screenScanDue } from './idleCadence';

describe('backgroundPollDue — listing background sessions costs a claude process (~340 ms)', () => {
  const base = { now: 100_000, lastPollMs: 0, windowFocused: true, hasRows: true };
  it('every 30 s while the window is focused and there are rows to keep current', () => {
    expect(backgroundPollDue({ ...base, now: 29_999 })).toBe(false);
    expect(backgroundPollDue({ ...base, now: 30_000 })).toBe(true);
  });
  it('every minute when the group is empty everywhere — a new claude --bg still shows within a minute', () => {
    expect(backgroundPollDue({ ...base, hasRows: false, now: 59_999 })).toBe(false);
    expect(backgroundPollDue({ ...base, hasRows: false, now: 60_000 })).toBe(true);
  });
  it('every two minutes while the window is not focused, rows or not', () => {
    expect(backgroundPollDue({ ...base, windowFocused: false, now: 119_999 })).toBe(false);
    expect(backgroundPollDue({ ...base, windowFocused: false, hasRows: false, now: 120_000 })).toBe(true);
  });
});

describe('gitRefreshDue — two git processes per tile, more for a workspace', () => {
  it('re-reads the selected tile on every tick', () => {
    for (const tick of [0, 1, 2, 3, 4, 5]) expect(gitRefreshDue({ tick, selected: true, windowHidden: false })).toBe(true);
  });
  it('re-reads the other tiles every fourth tick (two minutes): their row shows only branch and dirty count', () => {
    expect([0, 1, 2, 3, 4, 5, 8].map((tick) => gitRefreshDue({ tick, selected: false, windowHidden: false }))).toEqual([true, false, false, false, true, false, true]);
  });
  it('re-reads nothing while the window is hidden — no row is on screen', () => {
    expect(gitRefreshDue({ tick: 0, selected: true, windowHidden: true })).toBe(false);
    expect(gitRefreshDue({ tick: 4, selected: false, windowHidden: true })).toBe(false);
  });
});

describe('a quiet terminal asks for nothing', () => {
  it('the agent probe (a listing of every process) only after the tile printed something', () => {
    expect(agentProbeDue({ lastDataAt: 1_000, probedAt: 1_000 })).toBe(false);
    expect(agentProbeDue({ lastDataAt: 1_001, probedAt: 1_000 })).toBe(true);
  });
  it('the screen scan after the terminal was written to, and for two more seconds while xterm catches up', () => {
    expect(screenScanDue({ writtenAt: 5_001, scannedAt: 5_000 })).toBe(true); // written since the last scan
    expect(screenScanDue({ writtenAt: 5_000, scannedAt: 6_000 })).toBe(true); // scanned 1 s after the write: xterm may not have drawn it yet
    expect(screenScanDue({ writtenAt: 5_000, scannedAt: 7_000 })).toBe(false); // settled: nothing new to read
  });
});
