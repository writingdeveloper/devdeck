import { tr } from './i18n-runtime';

/**
 * Replace a view's content with a retryable error state. A view loader whose IPC call rejects used to
 * leave its first-load skeleton (or a blank pane) on screen forever with no way to recover; this gives
 * the user a clear message + a Retry button instead.
 */
export function renderLoadError(container: HTMLElement, retry: () => void): void {
  container.replaceChildren();
  const box = document.createElement('div'); box.className = 'load-error';
  const msg = document.createElement('div'); msg.className = 'load-error-msg'; msg.textContent = tr('common.load_failed');
  const btn = document.createElement('button'); btn.className = 'chip load-error-retry'; btn.textContent = tr('common.retry');
  btn.addEventListener('click', retry);
  box.append(msg, btn);
  container.appendChild(box);
}

/** Transient toast in the shared #toast-host (same pattern main.ts uses for main-process errors). */
export function toast(message: string): void {
  if (collecting) { collecting.push(message); return; }
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/** Messages gathered by collectToasts while it runs, or null outside one. */
let collecting: string[] | null = null;

/**
 * Run a bulk action and show the toasts it raises as ONE toast when there are many.
 *
 * Closing a dozen sessions on a PC that refuses, or restoring ten saved entries for a PC that is
 * offline, toasted once per row — a stack past the top of the window, every line saying the same
 * thing with a different name. Up to two messages are shown as they are; more become one line from
 * `summary`, which gets them all (the diagnostics log keeps the individual ones).
 */
export async function collectToasts<T>(run: () => Promise<T>, summary: (messages: string[]) => string): Promise<T> {
  if (collecting) return run(); // already inside one: the outer collection takes these too
  const mine: string[] = [];
  collecting = mine;
  try { return await run(); } finally {
    collecting = null;
    if (mine.length <= 2) for (const message of mine) toast(message);
    else toast(summary(mine));
  }
}

/** A toast that stays and can be rewritten while something long runs (a large file being sent). */
export function progressToast(): { set(message: string): void; close(): void } {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
  host?.appendChild(el);
  return { set: (message) => { el.textContent = message; }, close: () => el.remove() };
}

/** Handled write failures still belong in diagnostics; never include the user's draft text. */
export function reportSaveError(error: unknown): void {
  toast(tr('common.save_failed'));
  try {
    window.devdeck.logDiagnostic(`save failed: ${error instanceof Error ? error.message : String(error)}`, 'error', 'store');
  } catch { /* the renderer may be shutting down */ }
}

/**
 * A neutral toast that reports a reversible change and offers to undo it.
 *
 * Used for actions whose *result* is off-screen — unpinning moves a row to a group you may not be
 * looking at, and with nothing to say so it reads as a deletion. Saying where it went, plus a way back,
 * is what makes the action safe to try. Announced politely so a screen reader hears it without being
 * interrupted mid-sentence.
 */
export function undoToast(message: string, undoLabel: string, onUndo: () => void): void {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div'); el.className = 'toast toast-info'; el.setAttribute('role', 'status');
  const text = document.createElement('span'); text.className = 'toast-text'; text.textContent = message;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'toast-action'; button.textContent = undoLabel;
  button.addEventListener('click', () => { el.remove(); onUndo(); });
  el.append(text, button);
  host.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}
