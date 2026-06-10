import { app } from 'electron';

/** True only where we actually register a login item: packaged Windows builds. */
export function autoStartSupported(): boolean {
  return app.isPackaged && process.platform === 'win32';
}

/**
 * Reflect the stored "open at login" preference into the OS. No-op in dev or off
 * Windows, so we never register the dev electron binary or touch unsupported
 * platforms. The window opens normally at login (no hidden start).
 */
export function applyOpenAtLogin(enabled: boolean): void {
  if (!autoStartSupported()) return;
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/** Live OS state when supported, else the caller's stored fallback. */
export function effectiveOpenAtLogin(storedFallback: boolean): boolean {
  if (!autoStartSupported()) return storedFallback;
  return app.getLoginItemSettings().openAtLogin;
}
