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

export type AppCrashKind = 'render-process-gone' | 'child-process-gone';
export interface AppCrashDetail { reason: string; exitCode: number; type?: string; }

/**
 * Electron's `render-process-gone` (renderer/GPU-tab crash) and `child-process-gone` (GPU/utility
 * process crash) fire on `app`, not `process` — installGlobalErrorHandlers can't see them. Before
 * this, a renderer or GPU crash left ZERO trace anywhere (no devdeck-errors.log entry, no Windows
 * crash event), one of the leading suspects for DevDeck "closing for no reason". `reason ===
 * 'clean-exit'` is a normal window close/reload, not a crash — skipped so it doesn't spam the log.
 */
export interface CrashRecoveryDeps {
  log: (kind: AppCrashKind, detail: AppCrashDetail) => void;
  reapPtys: () => void;
  reloadWindow: () => void;
}

/**
 * What to actually DO when a crash event fires (installAppCrashHandlers only observes).
 * A dead renderer loses its in-memory session map while its node-pty conptys keep running in main
 * with no owner; the reload then restores sessions from the persisted list with FRESH ptys. Reap
 * the orphans first, or every renderer crash leaks — and double-runs — a full set of terminals.
 * A GPU/utility crash (`child-process-gone`) leaves the renderer alive, so it is log-only.
 */
export function makeCrashRecovery(deps: CrashRecoveryDeps): (kind: AppCrashKind, detail: AppCrashDetail) => void {
  return (kind, detail) => {
    try { deps.log(kind, detail); } catch { /* logging is best-effort */ }
    if (kind !== 'render-process-gone') return;
    try { deps.reapPtys(); } catch { /* a failed kill must not block the reload */ }
    try { deps.reloadWindow(); } catch { /* window may already be tearing down */ }
  };
}

export function installAppCrashHandlers(
  appLike: NodeJS.EventEmitter,
  onEvent: (kind: AppCrashKind, detail: AppCrashDetail) => void,
): void {
  const guard = (kind: AppCrashKind) => (...args: unknown[]) => {
    const detail = args[args.length - 1] as AppCrashDetail;
    if (detail?.reason === 'clean-exit') return;
    try { onEvent(kind, detail); } catch { /* swallow — logging is best-effort */ }
  };
  appLike.on('render-process-gone', guard('render-process-gone'));
  appLike.on('child-process-gone', guard('child-process-gone'));
}
