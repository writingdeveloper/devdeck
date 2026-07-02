export type KeyAction = 'copy' | 'paste' | 'find' | 'pass';

/** The keyboard-event shape we need — a subset of DOM KeyboardEvent, so it's unit-testable without a DOM. */
export interface KeyLike {
  type?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  key: string;
}

/**
 * Decide what an embedded-terminal keystroke should do BEFORE it's forwarded to the PTY.
 *
 * The conflict this resolves: xterm forwards Ctrl+C to the PTY as \x03 (SIGINT), so a user
 * pressing Ctrl+C to COPY a selection interrupts the agent and the text appears to vanish.
 *
 * - Ctrl+C (or Ctrl+Shift+C) WITH a selection -> copy. Plain Ctrl+C with NO selection falls
 *   through to 'pass' so the interrupt still works.
 * - Ctrl+V / Ctrl+Shift+V -> paste (Windows-terminal convention).
 * - Ctrl+F -> find (open the in-terminal search bar instead of sending \x06 to the PTY).
 * - Everything else passes through to the PTY unchanged.
 *
 * Alt is excluded so Alt+C / Alt+V (rare app bindings) are never hijacked.
 */
export function decideKeyAction(e: KeyLike, hasSelection: boolean): KeyAction {
  if (e.type && e.type !== 'keydown') return 'pass';
  if (e.repeat) return 'pass'; // ignore OS key auto-repeat — a held Ctrl+V must paste once, not repeatedly
  if (e.altKey || !e.ctrlKey) return 'pass';
  const k = e.key.toLowerCase();
  if (k === 'c' && hasSelection) return 'copy';
  if (k === 'v') return 'paste';
  if (k === 'f') return 'find';
  return 'pass';
}
