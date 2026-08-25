/**
 * Who decides how big a shared pty is.
 *
 * A pty has ONE size, and any number of terminals can be attached to it: this deck's tile, and a tile
 * on every machine watching the same session over the link. Each of them fits to its own window, so
 * whichever laid out last left the pty at ITS size and every other one went on drawing at a width the
 * pty no longer has — which is not a cosmetic disagreement. ConPTY repaints on its own idea of the
 * geometry, so the rows past the narrower width keep the previous, wider paint while the new one is
 * drawn over their left half: the split screen this is reported as.
 *
 * The rule is the one terminal multiplexers settled on: the pty is sized to the SMALLEST attached
 * view, and larger views simply leave the extra space empty. Nobody has to know who else is attached
 * — each view only answers, about a size it is told the pty now has, "can I show that?".
 */
export interface TerminalDims { cols: number; rows: number }

export type SizeFollow =
  /** Already agreed — the common case, including the echo of this view's own resize. */
  | { action: 'ignore' }
  /** The pty fits in this view; take its size and leave the spare space blank. */
  | { action: 'adopt'; size: TerminalDims }
  /** This view is the smaller one; put a size everyone can show back on the pty. */
  | { action: 'claim'; size: TerminalDims };

/**
 * What a view should do when it learns the pty's size.
 *
 * `pane` is what this view could show at most — null when nothing has measured it yet, in which case
 * agreeing with the pty still beats disagreeing with it.
 *
 * A claim is the componentwise MINIMUM of the two, never the pane alone: raising a dimension the
 * other view is smaller in would be answered by it lowering that dimension again, and the two would
 * trade sizes forever. Taking the minimum makes every exchange strictly smaller in at least one
 * dimension, so it settles — at the smallest view — after one round. Growing back is not this
 * function's job; a real layout change (a window resize, a Refresh) proposes the pane size again.
 */
export function followPtySize(mine: TerminalDims, pty: TerminalDims, pane: TerminalDims | null): SizeFollow {
  if (pty.cols === mine.cols && pty.rows === mine.rows) return { action: 'ignore' };
  if (!pane || (pty.cols <= pane.cols && pty.rows <= pane.rows)) return { action: 'adopt', size: { cols: pty.cols, rows: pty.rows } };
  const size = { cols: Math.min(pane.cols, pty.cols), rows: Math.min(pane.rows, pty.rows) };
  return { action: 'claim', size };
}
