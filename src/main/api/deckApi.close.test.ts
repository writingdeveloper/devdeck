import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  clipboard: { readImage: vi.fn() },
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
}));

import { createDeckApi, type DeckApiConfig } from './deckApi';
import type { DeckApi } from './methods';
import { remoteCallContext } from '../link/hostServer';
import { qualifyRemoteId } from '../../shared/link/machine';

// A real folder: opening a session checks that its folder exists.
const ALLOWED_ROOT = mkdtempSync(join(tmpdir(), 'devdeck-close-root-'));
afterAll(() => { rmSync(ALLOWED_ROOT, { recursive: true, force: true }); });

/** A pty table whose terminals exit when killed, the way node-pty reports it: asynchronously. */
function makePtys() {
  const sessions = new Map<string, { onExit: (e: { exitCode: number }) => void }>();
  return {
    killed: [] as string[],
    create(id: string, _f: string, _a: string[], _c: string, _w: number, _h: number, _d: unknown, onExit: (e: { exitCode: number }) => void) {
      sessions.set(id, { onExit });
    },
    list() { return [...sessions.keys()].map((id) => ({ id, projectPath: ALLOWED_ROOT, sessionId: null, agentId: 'claude', startedAtMs: 0, label: null })); },
    programStatus() { return false; },
    kill(id: string) {
      const s = sessions.get(id); if (!s) return;
      sessions.delete(id); this.killed.push(id);
      queueMicrotask(() => s.onExit({ exitCode: 1 }));
    },
    exit(id: string) { const s = sessions.get(id); sessions.delete(id); s?.onExit({ exitCode: 0 }); },
    note: () => false, pid: () => null, buffer: () => ({ data: '', cols: 0, rows: 0 }),
  };
}

type Link = { machines: () => { machineId: string; state: string }[]; call: (m: string, method: string, args: unknown[]) => Promise<unknown>; notify: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> };

function build(link: Link | null) {
  const ptys = makePtys();
  const bundle = createDeckApi({
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: { getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }], getAgent: () => 'claude', getSessionSummary: () => true, getAiSessionSummary: () => false, getProgramStatus: () => false, getCockpitSessions: () => [], setCockpitSessions: () => {}, setLastOpened: () => {} },
    sendError: vi.fn(), defaultLanguage: 'en', ptyHost: ptys, ptyAvailable: true,
    tray: { applyCounts: vi.fn(), setAlertImage: vi.fn() }, shutdown: null, shutdownLog: null, bootTimeMs: () => 0,
    link: () => link,
  } as unknown as DeckApiConfig);
  const exits: unknown[] = [];
  bundle.events.subscribe((channel, payload) => { if (channel === 'cockpit:exit') exits.push(payload); });
  return { api: bundle.methods as DeckApi, ptys, exits };
}

const call = (api: DeckApi, name: string, ...args: unknown[]) => Promise.resolve(api[name].handler(...args));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('closing a session', () => {
  let link: Link;
  beforeEach(() => {
    link = { machines: () => [{ machineId: '0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', state: 'connected' }], call: vi.fn(async () => ({ ok: true })), notify: vi.fn(), detach: vi.fn(), attach: vi.fn() };
  });

  it('tells every deck showing it that it was CLOSED, not that it crashed', async () => {
    const { api, ptys, exits } = build(link);
    const res = await call(api, 'cockpit:open', { projectPath: ALLOWED_ROOT, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' }) as { id: string };
    expect(res.id).toBeTruthy();
    await call(api, 'cockpit:closeSession', res.id);
    await flush();
    expect(exits).toContainEqual({ id: res.id, exitCode: 1, closed: true, closedBy: 'local' });
  });

  it('marks a close requested by a paired machine as remote', async () => {
    const { api, exits } = build(link);
    const res = await call(api, 'cockpit:open', { projectPath: ALLOWED_ROOT, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' }) as { id: string };
    await remoteCallContext.run('remote', () => call(api, 'cockpit:closeSession', res.id));
    await flush();
    expect(exits).toContainEqual({ id: res.id, exitCode: 1, closed: true, closedBy: 'remote' });
  });

  it('an exit nobody asked for stays a plain exit', async () => {
    const { api, ptys, exits } = build(link);
    const res = await call(api, 'cockpit:open', { projectPath: ALLOWED_ROOT, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' }) as { id: string };
    ptys.exit(res.id);
    expect(exits).toContainEqual({ id: res.id, exitCode: 0 });
  });

  it('the legacy notify close is marked too', async () => {
    const { api, exits } = build(link);
    const res = await call(api, 'cockpit:open', { projectPath: ALLOWED_ROOT, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' }) as { id: string };
    api['cockpit:close'].handler(res.id);
    await flush();
    expect(exits).toContainEqual({ id: res.id, exitCode: 1, closed: true, closedBy: 'local' });
  });

  const remoteId = qualifyRemoteId('0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', 'C:\\repo#3');

  it('a remote close is ASKED, and answered', async () => {
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: true });
    expect(link.call).toHaveBeenCalledWith('0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', 'cockpit:closeSession', ['C:\\repo#3']);
    expect(link.detach).toHaveBeenCalledWith(remoteId);
  });

  it('an unreachable machine is reported as offline, so the close can be sent later', async () => {
    link.machines = () => [{ machineId: '0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', state: 'offline' }];
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: false, reason: 'offline' });
    expect(link.call).not.toHaveBeenCalled();
    link.machines = () => [{ machineId: '0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', state: 'connected' }];
    link.call = vi.fn(async () => { throw new Error('link is closed'); });
    expect(await call(api, 'cockpit:closeSession', remoteId)).toMatchObject({ ok: false, reason: 'offline' });
  });

  it('a refusal says so instead of pretending the session closed', async () => {
    link.call = vi.fn(async () => { throw new Error('not permitted: cockpit:closeSession'); });
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: false, reason: 'denied' });
  });

  it('a session already gone there is a close already done', async () => {
    link.call = vi.fn(async () => { throw new Error('not a session on this machine: cockpit:closeSession'); });
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: true });
  });

  it('falls back to the old notify for a host that predates the answered close', async () => {
    link.call = vi.fn(async () => { throw new Error('no such method: cockpit:closeSession'); });
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: true });
    expect(link.notify).toHaveBeenCalledWith('0b6b3c1e-6f7a-4c2d-9a8e-1f2e3d4c5b6a', 'cockpit:close', ['C:\\repo#3']);
  });

  it('waits out the host rate limit rather than dropping part of a bulk close', async () => {
    let n = 0;
    link.call = vi.fn(async () => { if (n++ < 2) throw new Error('too many requests: cockpit:closeSession'); return { ok: true }; });
    const { api } = build(link);
    expect(await call(api, 'cockpit:closeSession', remoteId)).toEqual({ ok: true });
    expect(link.call).toHaveBeenCalledTimes(3);
  });

  it('refuses to relay a qualified id for a remote caller', async () => {
    const { api } = build(link);
    expect(await remoteCallContext.run('remote', () => call(api, 'cockpit:closeSession', remoteId))).toEqual({ ok: false, reason: 'error' });
    expect(link.call).not.toHaveBeenCalled();
  });
});
