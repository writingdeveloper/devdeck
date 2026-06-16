import { app, Tray, Menu, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { join } from 'node:path';

export type TrayAlertMode = 'off' | 'attention' | 'all';
export interface TrayController {
  /** Receive the renderer-rendered red-dotted alert icon (a PNG data URL). */
  setAlertImage(dataUrl: string): void;
  /** Apply needs-you counts: redden the tray icon when the mode says there's something for you. */
  applyCounts(counts: { attention: number; turn: number }, mode: TrayAlertMode): void;
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
      const red = mode === 'off' ? 0 : mode === 'all' ? counts.attention + counts.turn : counts.attention;
      tray.setImage(red > 0 && alertIcon ? alertIcon : normalIcon);
      tray.setToolTip(red > 0 ? `DevDeck — ${red}` : 'DevDeck');
    },
  };
}
