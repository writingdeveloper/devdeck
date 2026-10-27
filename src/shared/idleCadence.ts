// How often the cockpit's periodic work runs while nobody is doing anything.
//
// Measured on Windows with two sessions open (DevDeck 1.47.0): the cockpit spent about 5% of a core
// at rest, most of it in work that could not have changed anything — a PowerShell process listing
// (~500 ms) and two git processes per tile every 30 s to re-read what the tiles were already showing,
// a `claude agents` process (~340 ms) every 30 s to list background sessions for a group that was
// empty, and a scan of every terminal's screen once a second whether or not it had printed anything.
// These rules keep each of those for the moments they can matter.

/** The sidebar's background-session poll: 30 s while someone is looking and there is something to watch. */
export const BACKGROUND_POLL_MS = 30_000;
/** The group is empty: a new `claude --bg` shows within a minute, which is soon enough for a list that is usually empty. */
export const BACKGROUND_POLL_EMPTY_MS = 60_000;
/** The window is not focused: a list nobody is looking at can lag two minutes. */
export const BACKGROUND_POLL_UNFOCUSED_MS = 120_000;

export interface BackgroundPollCtx {
  now: number;
  lastPollMs: number;
  windowFocused: boolean;
  /** Any background session listed on any machine, or a background tile open. */
  hasRows: boolean;
}

/** Whether the background-session listing is due on this tick. */
export function backgroundPollDue(c: BackgroundPollCtx): boolean {
  const interval = !c.windowFocused ? BACKGROUND_POLL_UNFOCUSED_MS : c.hasRows ? BACKGROUND_POLL_MS : BACKGROUND_POLL_EMPTY_MS;
  return c.now - c.lastPollMs >= interval;
}

/** The 30 s meta tick: git branch / dirty count and workspace changes for the selected tile every tick … */
export const GIT_REFRESH_EVERY_TICKS_SELECTED = 1;
/** … and for the other tiles every fourth (two minutes): their row shows branch and dirty count, nothing more. */
export const GIT_REFRESH_EVERY_TICKS_OTHERS = 4;

export interface GitRefreshCtx {
  /** The meta tick's running count. */
  tick: number;
  selected: boolean;
  /** The window is hidden (tray, minimised): no row is on screen. */
  windowHidden: boolean;
}

/** Whether this tick re-reads a tile's git state (two git processes; more for a workspace). */
export function gitRefreshDue(c: GitRefreshCtx): boolean {
  if (c.windowHidden) return false;
  const every = c.selected ? GIT_REFRESH_EVERY_TICKS_SELECTED : GIT_REFRESH_EVERY_TICKS_OTHERS;
  return c.tick % every === 0;
}

/**
 * Whether a tile's agent can have changed since it was last probed: only if its terminal printed
 * anything. The probe lists every process on the machine (PowerShell on Windows, ~500 ms), so a
 * quiet tile must not ask for it.
 */
export function agentProbeDue(c: { lastDataAt: number; probedAt: number }): boolean {
  return c.lastDataAt > c.probedAt;
}

/**
 * xterm parses what it is given on a later frame, so a scan right after output can still see the
 * screen before it. A scan within this long of the last output is repeated once more.
 */
export const SCREEN_SETTLE_MS = 2_000;

/**
 * Whether a terminal's screen can differ from the last scan: only if it was written to since (output,
 * a replayed screen, a repaint), or the last scan came so soon after the write that the screen may
 * not have shown it yet.
 */
export function screenScanDue(c: { writtenAt: number; scannedAt: number }): boolean {
  return c.writtenAt + SCREEN_SETTLE_MS > c.scannedAt;
}
