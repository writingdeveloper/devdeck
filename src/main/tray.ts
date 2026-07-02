import { app, Tray, Menu, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { join } from 'node:path';
import { trayState, type TrayAlertMode, type TrayCounts } from '../shared/trayState';

export type { TrayAlertMode } from '../shared/trayState';
export interface TrayController {
  /** Receive the renderer-rendered red-dotted alert icon (a PNG data URL). */
  setAlertImage(dataUrl: string): void;
  /** Apply needs-you + overdue-task counts: redden the icon / word the tooltip per trayState. */
  applyCounts(counts: TrayCounts, mode: TrayAlertMode): void;
}

/** Build a tray icon with Open/Quit, make close hide to tray, and return a controller for the alert state. */
export function setupTray(win: BrowserWindow): TrayController {
  const normalIcon = nativeImage.createFromPath(join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
  const tray = new Tray(normalIcon);
  tray.setToolTip('DevDeck');
  const menu = Menu.buildFromTemplate([
    { label: 'Open DevDeck', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as unknown as { isQuitting?: boolean }).isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { win.show(); win.focus(); });

  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  let alertIcon: NativeImage | null = null;
  return {
    setAlertImage(dataUrl: string): void {
      try { const img = nativeImage.createFromDataURL(dataUrl); if (!img.isEmpty()) alertIcon = img; } catch { /* ignore */ }
    },
    applyCounts(counts, mode): void {
      const s = trayState(counts, mode);
      tray.setImage(s.red > 0 && alertIcon ? alertIcon : normalIcon);
      tray.setToolTip(s.tooltip);
    },
  };
}
