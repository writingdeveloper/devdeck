/**
 * Process-level last-resort error trap for the Electron MAIN process.
 *
 * Without this, an exception thrown from an async callback — a node-pty data/exit handler, the
 * PtyBatcher's setTimeout flush, a git spawn, an IPC handler's stray reject — has no catch frame
 * above it and terminates the main process. That takes every cockpit terminal down at once and
 * looks like DevDeck "suddenly closing" (no Crashpad/WER report, because it's a JS exit, not a
 * native crash). We log and keep running: buffered PTY output and the on-disk session list survive,
 * and the next user action re-drives the UI.
 *
 * The process emitter is injected (defaults to the real `process`) so the wiring is unit-testable
 * without registering global handlers that would leak across the test suite.
 */
export type GlobalErrorKind = 'uncaughtException' | 'unhandledRejection';

export function installGlobalErrorHandlers(
  onError: (kind: GlobalErrorKind, err: unknown) => void,
  proc: NodeJS.EventEmitter = process,
): void {
  const guard = (kind: GlobalErrorKind) => (err: unknown) => {
    // A failure inside onError (e.g. the logger itself throws) must not re-enter the trap and crash.
    try { onError(kind, err); } catch { /* swallow — logging is best-effort */ }
  };
  proc.on('uncaughtException', guard('uncaughtException'));
  proc.on('unhandledRejection', guard('unhandledRejection'));
}
