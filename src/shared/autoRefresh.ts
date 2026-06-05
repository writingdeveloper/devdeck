export interface AutoRefreshCtx {
  now: number;
  lastLoadMs: number;
  intervalMs: number;
  viewActive: boolean;
  windowFocused: boolean;
}

/**
 * Whether the projects deck should auto-reload on this tick: only when it is the
 * active view AND the window is focused (don't churn in the background) AND at
 * least intervalMs has passed since the last load.
 */
export function shouldAutoRefresh(c: AutoRefreshCtx): boolean {
  return c.viewActive && c.windowFocused && c.now - c.lastLoadMs >= c.intervalMs;
}
