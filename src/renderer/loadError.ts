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
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
