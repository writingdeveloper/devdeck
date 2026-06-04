import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';

/** Build a tray icon with Open/Quit, and make window-close hide to tray instead of quitting. */
export function setupTray(win: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
  const tray = new Tray(icon);
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
  return tray;
}
