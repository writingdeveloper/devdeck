import { ipcMain } from 'electron';
import { createDeckApi, type DeckApiBundle, type DeckApiConfig } from './api/deckApi';
import type { DeckApi } from './api/methods';

/** Unchanged name/shape for every existing caller; the fields now live with the API table. */
export type IpcConfig = DeckApiConfig;

/**
 * Bind this machine's capability table (api/deckApi.ts) to Electron IPC.
 *
 * This file used to BE the capability table — 700 lines of handler bodies nested inside
 * `ipcMain.handle(...)`. That shape made the renderer the only possible caller, which is precisely
 * what has to change for a session on another machine to be driven from here: the remote link runs the
 * SAME handlers, so there is one implementation and one security model rather than two that drift.
 * What remains here is the local transport and the window events that have no meaning off this machine.
 */
export function registerIpc(cfg: IpcConfig): DeckApiBundle {
  const bundle = createDeckApi(cfg);
  const { methods, events } = bundle;
  registerDeckApi(methods);

  // The window is now one subscriber to the API's pushes rather than their hard-coded destination.
  // webContents.send throws if the renderer is torn down mid-send (reload/quit), and that throw used
  // to escape through the pty data/exit callback that published the event — so the guard lives here,
  // with the transport that can actually go away.
  events.subscribe((channel, payload) => {
    try { if (!cfg.win.isDestroyed()) cfg.win.webContents.send(channel, payload); } catch { /* renderer gone */ }
  });

  // Frameless-window chrome: a push the renderer needs but no method produces, so it is wired at the
  // transport rather than in the table.
  cfg.win.on('maximize', () => cfg.win.webContents.send('win:maximize-changed', true));
  cfg.win.on('unmaximize', () => cfg.win.webContents.send('win:maximize-changed', false));

  // Handed back so the link can serve the same table to a paired machine. It cannot be passed IN,
  // because building the link needs the table.
  return bundle;
}

/**
 * `invoke` methods answer (`ipcMain.handle`); `send` methods do not (`ipcMain.on`). The Electron event
 * argument is dropped: no handler ever read it, and a method that depended on its caller's identity
 * could not be served to a remote caller unchanged.
 */
function registerDeckApi(api: DeckApi): void {
  for (const [name, method] of Object.entries(api)) {
    if (method.channel === 'invoke') ipcMain.handle(name, (_event, ...args) => method.handler(...args));
    else ipcMain.on(name, (_event, ...args) => { method.handler(...args); });
  }
}
