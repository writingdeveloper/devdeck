export type UpdatePayload =
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'checking' }
  | { status: 'none' };

/** Minimal surface of electron-updater's autoUpdater that we use — lets us unit-test wiring without electron. */
export interface UpdaterLike {
  autoDownload: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdaterApi { check(): void; download(): void; install(): void; }

/** Attach listeners translating updater events into UpdatePayloads sent to the renderer. */
export function wireUpdater(
  u: UpdaterLike,
  send: (p: UpdatePayload) => void,
  log: (e: unknown) => void,
): UpdaterApi {
  u.autoDownload = false;
  u.on('update-available', (info: any) => send({ status: 'available', version: String(info?.version ?? '') }));
  u.on('download-progress', (p: any) => send({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }));
  u.on('update-downloaded', (info: any) => send({ status: 'downloaded', version: String(info?.version ?? '') }));
  u.on('update-not-available', () => send({ status: 'none' }));
  u.on('error', (e: unknown) => log(e));
  return {
    check: () => { u.checkForUpdates().catch(log); },
    download: () => { u.downloadUpdate().catch(log); },
    install: () => u.quitAndInstall(),
  };
}
