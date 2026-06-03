import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron';

/** Build a tray icon with Open/Quit, and make window-close hide to tray instead of quitting. */
export function setupTray(win: BrowserWindow): Tray {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  );
  const tray = new Tray(icon);
  tray.setToolTip('DevDeck');
  const menu = Menu.buildFromTemplate([
    { label: 'Open DevDeck', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as unknown as { isQuitting: boolean }).isQuitting = true; app.quit(); } },
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
