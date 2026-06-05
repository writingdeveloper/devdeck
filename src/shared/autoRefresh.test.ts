import { describe, it, expect } from 'vitest';
import { shouldAutoRefresh } from './autoRefresh';

const base = { now: 100_000, lastLoadMs: 0, intervalMs: 45_000, viewActive: true, windowFocused: true };

describe('shouldAutoRefresh', () => {
  it('refreshes when active, focused, and the interval has elapsed', () => {
    expect(shouldAutoRefresh(base)).toBe(true);
  });
  it('does not refresh too soon', () => {
    expect(shouldAutoRefresh({ ...base, now: 10_000 })).toBe(false);
  });
  it('does not refresh when the view is inactive', () => {
    expect(shouldAutoRefresh({ ...base, viewActive: false })).toBe(false);
  });
  it('does not refresh when the window is unfocused', () => {
    expect(shouldAutoRefresh({ ...base, windowFocused: false })).toBe(false);
  });
  it('refreshes exactly at the interval boundary', () => {
    expect(shouldAutoRefresh({ ...base, now: 45_000, lastLoadMs: 0 })).toBe(true);
  });
});
