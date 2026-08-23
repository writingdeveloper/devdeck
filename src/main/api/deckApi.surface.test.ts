import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'node:path';

// deckApi reaches Electron for dialogs/clipboard/app info; none of that is exercised here — this file
// is about the SHAPE of the capability table, not its handlers' behavior (ipc.guard/ipc.cockpit cover those).
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  clipboard: { readImage: vi.fn() },
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
}));

import { createDeckApi, type DeckApiConfig } from './deckApi';
import { mayCallRemotely, type DeckApi, type LinkPermission } from './methods';
import type { EventHub } from './events';

const ALLOWED_ROOT = join(process.cwd(), 'allowed-root');
const EVERY_PERMISSION: LinkPermission[] = ['observe', 'control', 'spawn', 'write', 'power'];

let api: DeckApi;
let events: EventHub;

/** Just enough of the link to see what the API asks it to do. */
const attachCalls: { id: string; cols: number; rows: number }[] = [];
const fakeLink = {
  call: async (machineId: string, method: string) =>
    (method === 'cockpit:open' ? { id: 'C:\\repo#3', agentId: 'claude', sessionId: 'abc' } : { machineId, method }),
  notify: () => undefined,
  attach: (id: string, cols: number, rows: number) => { attachCalls.push({ id, cols, rows }); },
  detach: () => undefined,
};

beforeAll(() => {
  const bundle = createDeckApi({
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: {
      getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }],
      getTrayAlert: () => 'attention',
      getShutdownIdleMinutes: () => 10,
      getSessionSummary: () => true,
      getAiSessionSummary: () => false,
    },
    sendError: vi.fn(),
    defaultLanguage: 'en',
    ptyHost: {},
    ptyAvailable: true,
    tray: { applyCounts: vi.fn(), setAlertImage: vi.fn() },
    shutdown: { arm: vi.fn(), disarm: vi.fn(), shutdownNow: vi.fn(), cancel: vi.fn(), status: vi.fn(), noteReport: vi.fn() },
    shutdownLog: { read: vi.fn(() => []), updateLast: vi.fn(), append: vi.fn(), clear: vi.fn() },
    bootTimeMs: () => 0,
    link: () => fakeLink,
  } as unknown as DeckApiConfig);
  api = bundle.methods;
  events = bundle.events;
});

describe('deck API surface', () => {
  it('exposes the same channel names the renderer already calls', () => {
    // Spot-check across every family: the extraction from ipc.ts must not have renamed or dropped one.
    for (const name of [
      'projects:list', 'project:memory', 'usage:report', 'settings:get', 'settings:getFolders',
      'cockpit:open', 'cockpit:input', 'cockpit:resize', 'cockpit:close', 'cockpit:sessionMeta',
      'usage:snapshot', 'clipboard:readImage', 'win:isMaximized', 'shutdown:status',
    ]) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('hands back an event hub that starts with no destination bound', () => {
    // The API no longer knows where its pushes go. Whoever serves it — the local IPC bridge, a remote
    // link — subscribes; building the table wires nothing on its own.
    expect(events.sinkCount).toBe(0);
  });

  it('keeps fire-and-forget channels fire-and-forget', () => {
    // These were `ipcMain.on` before the extraction. Registering one as `invoke` would leave the
    // renderer's `.send()` calls unanswered-but-awaited on the link side.
    for (const name of ['cockpit:input', 'cockpit:resize', 'cockpit:close', 'cockpit:saveSessions',
      'clipboard:writeText', 'tray:alertImage', 'tray:counts', 'shutdown:report']) {
      expect(api[name]?.channel, name).toBe('send');
    }
  });
});

describe('remote exposure policy', () => {
  it('classifies every method — a new channel cannot ship unclassified', () => {
    // The table's builder requires a policy argument, so this really asserts that no method carries a
    // malformed one. The point is that adding a channel forces the author to decide what it means
    // across machines, rather than inheriting a default.
    for (const [name, method] of Object.entries(api)) {
      expect(['allow', 'local', 'blocked'], name).toContain(method.remote.remote);
      if (method.remote.remote === 'allow') expect(EVERY_PERMISSION, name).toContain(method.remote.permission);
      if (method.remote.remote === 'blocked') expect(method.remote.reason, name).toBeTruthy();
    }
  });

  it('never lets a paired device widen the host allowlist or start a credential login', () => {
    // These are invariants, not preferences: settings:addFolder is the only channel that WIDENS the
    // path allowlist every other guard checks against, and it is bound to a native picker the person
    // at that machine must click (v1.24.0). usage:login spawns an interactive OAuth shell.
    for (const name of ['settings:addFolder', 'settings:removeFolder', 'settings:pickFolder', 'usage:login']) {
      expect(api[name]?.remote.remote, name).toBe('blocked');
      expect(mayCallRemotely(api[name], EVERY_PERMISSION), name).toBe(false);
    }
  });

  it('keeps shutting the machine down behind its own permission', () => {
    // Observing a machine must never imply being able to power it off while its own user is at it.
    for (const name of ['shutdown:arm', 'shutdown:now', 'shutdown:setIdleMinutes']) {
      expect(mayCallRemotely(api[name], ['observe', 'control', 'spawn', 'write']), name).toBe(false);
      expect(mayCallRemotely(api[name], ['power']), name).toBe(true);
    }
  });

  it('does not route the viewer\'s own window, clipboard and tile list to another machine', () => {
    for (const name of ['win:minimize', 'win:close', 'win:isMaximized', 'clipboard:readText',
      'clipboard:writeText', 'cockpit:loadSessions', 'cockpit:saveSessions', 'tray:counts']) {
      expect(api[name]?.remote.remote, name).toBe('local');
    }
  });

  it('lets an observer read the deck but not type into a session or start one', () => {
    const observer: LinkPermission[] = ['observe'];
    expect(mayCallRemotely(api['projects:list'], observer)).toBe(true);
    expect(mayCallRemotely(api['cockpit:sessionMeta'], observer)).toBe(true);
    expect(mayCallRemotely(api['cockpit:gitInfo'], observer)).toBe(true);
    expect(mayCallRemotely(api['cockpit:input'], observer)).toBe(false);
    expect(mayCallRemotely(api['cockpit:open'], observer)).toBe(false);
    expect(mayCallRemotely(api['project:setNote'], observer)).toBe(false);
  });
});

describe('routing a call to another machine', () => {
  it('qualifies a remote session id so every later call routes itself', async () => {
    // The host mints an id that means nothing here — two machines hand out the same ones. Qualifying
    // it at this boundary is what lets input/resize/close stay machine-agnostic.
    const machineId = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const opened = await api['link:call'].handler(machineId, 'cockpit:open', [{ projectPath: 'C:\\repo', cols: 120, rows: 40 }]) as { id: string };
    expect(opened.id).toBe(`link:${machineId}:C:\\repo#3`);
  });

  it('attaches to the remote session immediately, not on some later resize', async () => {
    // A host streams a session's bytes only to viewers attached to it. Leaving the attach to the
    // tile's first resize meant a freshly opened remote terminal produced NOTHING — and if nothing
    // ever resized it, it stayed silent forever while looking perfectly healthy.
    attachCalls.length = 0;
    const machineId = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    await api['link:call'].handler(machineId, 'cockpit:open', [{ projectPath: 'C:\\repo', cols: 120, rows: 40 }]);
    expect(attachCalls).toEqual([{ id: `link:${machineId}:C:\\repo#3`, cols: 120, rows: 40 }]);
  });

  it('falls back to a usable size rather than attaching at zero', async () => {
    attachCalls.length = 0;
    await api['link:call'].handler('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'cockpit:open', [{ projectPath: 'C:\\repo' }]);
    expect(attachCalls[0]).toMatchObject({ cols: 80, rows: 24 });
  });

  it('leaves the answer of a non-open call alone', async () => {
    const value = await api['link:call'].handler('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'projects:list', []) as { method: string };
    expect(value.method).toBe('projects:list');
  });
});
