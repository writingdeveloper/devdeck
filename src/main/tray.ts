import { app, Tray, Menu, nativeImage, type BrowserWindow, type NativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { trayState, shutdownMenuShape, DEFAULT_TRAY_LABELS, type TrayAlertMode, type TrayCounts, type TrayLabels } from '../shared/trayState';
import type { ShutdownPhase } from '../shared/shutdownIdle';

export type { TrayAlertMode } from '../shared/trayState';
export interface TrayController {
  /** Receive the renderer-rendered red-dotted alert icon (a PNG data URL). */
  setAlertImage(dataUrl: string): void;
  /** Apply needs-you + overdue-task counts: redden the icon / word the tooltip per trayState. */
  applyCounts(counts: TrayCounts, mode: TrayAlertMode): void;
  /** Re-render the context menu for the idle-shutdown phase (checkbox / cancel item). */
  setShutdownPhase(phase: ShutdownPhase): void;
  /** Words for the menu and tooltip, in the language the window is showing. */
  setLabels(labels: TrayLabels): void;
}

export interface TrayShutdownHooks { toggle(): void; now(): void; cancel(): void }

/** Build a tray icon with Open/Quit (+ idle-shutdown items when hooks are given), make close hide to tray. */
export function setupTray(win: BrowserWindow, shutdownHooks?: TrayShutdownHooks): TrayController {
  const normalIcon = nativeImage.createFromPath(join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
  const tray = new Tray(normalIcon);
  tray.setToolTip('DevDeck');

  let shutdownPhase: ShutdownPhase | null = shutdownHooks ? 'disarmed' : null;
  let labels: TrayLabels = DEFAULT_TRAY_LABELS;
  let last: { counts: TrayCounts; mode: TrayAlertMode } | null = null;
  const rebuildMenu = (): void => {
    const items: MenuItemConstructorOptions[] = [
      { label: labels.open, click: () => { win.show(); win.focus(); } },
    ];
    const shape = shutdownMenuShape(shutdownPhase);
    if (shape.length) items.push({ type: 'separator' });
    for (const it of shape) {
      if (it.key === 'toggle') items.push({ label: labels.shutdownIdle, type: 'checkbox', checked: it.checked, click: () => shutdownHooks?.toggle() });
      else if (it.key === 'now') items.push({ label: labels.shutdownNow, click: () => shutdownHooks?.now() });
      else items.push({ label: labels.cancelShutdown, click: () => shutdownHooks?.cancel() });
    }
    items.push({ type: 'separator' }, { label: labels.quit, click: () => { (app as unknown as { isQuitting?: boolean }).isQuitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  rebuildMenu();
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
      last = { counts, mode };
      const s = trayState(counts, mode, labels);
      tray.setImage(s.red > 0 && alertIcon ? alertIcon : normalIcon);
      tray.setToolTip(s.tooltip);
    },
    setLabels(next): void {
      labels = { ...DEFAULT_TRAY_LABELS, ...next };
      rebuildMenu();
      if (last) { const s = trayState(last.counts, last.mode, labels); tray.setToolTip(s.tooltip); }
    },
    setShutdownPhase(phase): void {
      if (!shutdownHooks || phase === shutdownPhase) return;
      shutdownPhase = phase;
      rebuildMenu();
    },
  };
}
