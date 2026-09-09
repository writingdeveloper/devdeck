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
import { mayCallRemotely, sessionIdArgOf, type DeckApi, type LinkPermission } from './methods';
import type { EventHub } from './events';

const ALLOWED_ROOT = join(process.cwd(), 'allowed-root');
const EVERY_PERMISSION: LinkPermission[] = ['observe', 'control', 'spawn', 'write', 'power'];

let api: DeckApi;
let events: EventHub;

/** Just enough of the link to see what the API asks it to do. */
const attachCalls: { id: string; cols: number; rows: number }[] = [];
const notifyCalls: { machineId: string; method: string; args: unknown[] }[] = [];
const fakeLink = {
  call: async (machineId: string, method: string) => {
    if (method === 'cockpit:open') return { id: 'C:\\repo#3', agentId: 'claude', sessionId: 'abc' };
    if (method === 'cockpit:liveSessions') return [{ id: 'C:\\repo#3', projectPath: 'C:\\repo', sessionId: 'abc', agentId: 'claude', startedAtMs: 1, label: 'release prep' }];
    return { machineId, method };
  },
  notify: (machineId: string, method: string, args: unknown[]) => { notifyCalls.push({ machineId, method, args }); },
  attach: (id: string, cols: number, rows: number) => { attachCalls.push({ id, cols, rows }); },
  detach: () => undefined,
};

/** Enough of a pty table to see what the session-name channel writes and announces. */
const noteCalls: { id: string; patch: Record<string, unknown> }[] = [];
/** What this machine is running, as the pty table would announce it. Tests push into it. */
const fakeLive: { id: string; projectPath: string; sessionId: string | null; agentId: string; startedAtMs: number; label: string | null }[] = [];
const createCalls: string[] = [];
const fakePtyHost = {
  list: () => fakeLive,
  create: (id: string) => { createCalls.push(id); },
  note: (id: string, patch: Record<string, unknown>) => { noteCalls.push({ id, patch }); return patch.label !== 'already-set'; },
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
    ptyHost: fakePtyHost,
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

  it('declares the session-id argument on every method that routes by one', () => {
    // The host validates that argument before dispatch: a `link:`-qualified id from a paired machine
    // is a request to relay into a third machine, and an unannounced id is the OAuth login shell.
    // A method that routes by id without declaring it would skip both checks.
    for (const name of ['cockpit:input', 'cockpit:resize', 'cockpit:close', 'cockpit:renameSession',
      'cockpit:sessionBuffer', 'cockpit:sessionScreen', 'cockpit:liveAgent']) {
      expect(sessionIdArgOf(api[name]), name).toBe(0);
    }
  });

  it('never opens a window on this desktop for a caller who is not in front of it', () => {
    for (const name of ['projects:open', 'project:openFolder', 'project:openEditor', 'cockpit:openFile']) {
      expect(api[name]?.remote.remote, name).toBe('blocked');
    }
  });

  it('keeps this deck\'s own presentation settings out of a paired machine\'s reach', () => {
    for (const name of ['settings:setAgent', 'settings:setContextWindow', 'settings:setThresholds',
      'settings:setSessionSummary', 'settings:setAiSessionSummary']) {
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

  it('qualifies the sessions a machine says it is running, not just the ones opened from here', async () => {
    // A deck picks work up two ways: it is TOLD (the announcement, qualified as it is forwarded) and
    // it ASKS on connect — which is the reconnect path, and every machine that was already busy.
    // A bare id there produces a tile that names no machine: its keystrokes land in this machine's
    // pty table, where nothing has that id, and its output never arrives.
    const machineId = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const running = await api['link:call'].handler(machineId, 'cockpit:liveSessions', []) as { id: string; label: string }[];
    expect(running.map((s) => s.id)).toEqual([`link:${machineId}:C:\\repo#3`]);
    expect(running[0].label).toBe('release prep'); // and what it is called comes along with it
  });

  it('leaves the answer of a non-open call alone', async () => {
    const value = await api['link:call'].handler('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'projects:list', []) as { method: string };
    expect(value.method).toBe('projects:list');
  });
});

describe('opening a conversation this machine already runs', () => {
  it('hands back the running session instead of starting a second terminal for it', async () => {
    // A paired deck restoring its saved tiles asks for each conversation by id; this machine is
    // usually already running it in a tile of its own. A second `claude --resume` here was a
    // duplicate tab in front of the person at this machine, once per saved entry, on every launch.
    fakeLive.length = 0; createCalls.length = 0;
    fakeLive.push({ id: `${ALLOWED_ROOT}#7`, projectPath: ALLOWED_ROOT, sessionId: '0f9a2b1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', agentId: 'claude', startedAtMs: 1, label: 'mine' });
    const answer = await api['cockpit:open'].handler({ projectPath: ALLOWED_ROOT, sessionId: '0f9a2b1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', cols: 80, rows: 24, mode: 'auto', agentId: 'claude' }) as { id: string; sessionId: string | null; adopted?: boolean };
    expect(answer).toMatchObject({ id: `${ALLOWED_ROOT}#7`, sessionId: '0f9a2b1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', adopted: true });
    expect(createCalls).toEqual([]);
    fakeLive.length = 0;
  });
});

describe('confirmed session metadata contract', () => {
  it('requires reply-bearing rename, control permission and a local host session id', () => {
    expect(api['cockpit:renameSession'].channel).toBe('invoke');
    expect(mayCallRemotely(api['cockpit:renameSession'], ['observe'])).toBe(false);
    expect(mayCallRemotely(api['cockpit:renameSession'], ['control'])).toBe(true);
    expect(sessionIdArgOf(api['cockpit:renameSession'])).toBe(0);
  });
  it('keeps membership persistence local and acknowledged', () => {
    expect(api['cockpit:persistSessions'].channel).toBe('invoke');
    expect(mayCallRemotely(api['cockpit:persistSessions'], EVERY_PERMISSION)).toBe(false);
  });
  it('cannot bypass conflict checks using the legacy notification route', () => {
    noteCalls.length = 0;
    api['cockpit:noteLabel'].handler('C:\\repo#1', 'unconfirmed');
    expect(noteCalls).toEqual([]);
    expect(mayCallRemotely(api['cockpit:noteLabel'], EVERY_PERMISSION)).toBe(false);
  });
  it('returns a remote rename response to its initiating caller', async () => {
    const machineId = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const result = await api['cockpit:renameSession'].handler(`link:${machineId}:C:\\repo#3`, 'release', { instanceId: 'fixture', labelRevision: 0 });
    expect(result).toEqual({ machineId, method: 'cockpit:renameSession' });
  });
});

describe('receiving a pasted image from another machine', () => {
  const png = (body = Buffer.alloc(16)) =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body]).toString('base64');

  it('needs the permission that covers typing into a session, not mere observation', () => {
    // It writes a file on the host. An observer must not be able to.
    expect(mayCallRemotely(api['cockpit:receiveImage'], ['observe'])).toBe(false);
    expect(mayCallRemotely(api['cockpit:receiveImage'], ['control'])).toBe(true);
  });

  it('refuses anything that is not a PNG', () => {
    // Without the magic check this method writes attacker-chosen bytes to a predictable location on a
    // machine that granted nothing more than "type in sessions".
    for (const payload of [
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]).toString('base64'), // a PE header
      Buffer.from('#!/bin/sh rm -rf /').toString('base64'),
      Buffer.from('<svg onload=alert(1)>').toString('base64'),
      '', 'not base64 at all!!', Buffer.alloc(4).toString('base64'),
    ]) {
      expect(api['cockpit:receiveImage'].handler(payload), payload.slice(0, 12)).toBeNull();
    }
  });

  it('refuses a non-string payload rather than coercing it', () => {
    for (const payload of [null, undefined, 42, {}, ['a']]) {
      expect(api['cockpit:receiveImage'].handler(payload), String(payload)).toBeNull();
    }
  });

  it('refuses an oversized payload before decoding it', () => {
    // The ceiling exists twice over: a huge frame would break the link, and decoding first would let
    // a caller spend the host's memory to find that out.
    expect(api['cockpit:receiveImage'].handler('A'.repeat(30 * 1024 * 1024))).toBeNull();
  });

  it('accepts a real PNG and answers with a path the caller never chose', () => {
    const written = api['cockpit:receiveImage'].handler(png()) as string | null;
    expect(written).toMatch(/devdeck-paste-[0-9a-f-]{36}\.png$/);
  });
});


it('allows revision-checked task saves only to write-authorized devices', () => {
  expect(mayCallRemotely(api['project:saveTodos'], ['observe'])).toBe(false);
  expect(mayCallRemotely(api['project:saveTodos'], ['write'])).toBe(true);
  expect(() => api['project:setTodos'].handler(ALLOWED_ROOT, [])).toThrow('TASKS_CLIENT_OUTDATED');
  expect(() => api['project:saveTodos'].handler(join(process.cwd(), 'outside'), [], 0)).toThrow('allowed folders');
});
