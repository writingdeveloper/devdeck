import { beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const { handlers, claudeStats, codexStats } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  claudeStats: vi.fn(() => []),
  codexStats: vi.fn(() => []),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  clipboard: { readImage: vi.fn() },
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
}));

vi.mock('./sessions', () => ({ listSessionStats: claudeStats }));
vi.mock('./codexSessions', () => ({ listCodexSessionStats: codexStats }));

import { registerIpc, type IpcConfig } from './ipc';
import { getProvider, resolveOpenSession } from './agents';

const ALLOWED_ROOT = join(process.cwd(), 'cockpit-allowed-root');
let storedAgent = 'claude';

beforeAll(() => {
  registerIpc({
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: { getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }], getAgent: () => storedAgent },
    sendError: vi.fn(),
    defaultLanguage: 'en',
    ptyHost: {},
    ptyAvailable: true,
    tray: {},
    shutdown: null,
    shutdownLog: null,
    bootTimeMs: () => 0,
  } as unknown as IpcConfig);
});

describe('resolveOpenSession', () => {
  const claude = getProvider('claude');
  const antigravity = getProvider('antigravity');
  const UUID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789'; // hex — passes SESSION_ID_RE, like a real randomUUID()
  const gen = () => UUID;

  it('fresh => claude --session-id <uuid> and pins that id', () => {
    expect(resolveOpenSession(claude, { fresh: true, sessionId: null, sessionCount: 2, latestId: 'old', genId: gen }))
      .toEqual({ command: `claude --session-id ${UUID}`, sessionId: UUID });
  });
  it('resume a specific id', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: 'abc12345', sessionCount: 1, latestId: 'abc12345', genId: gen }))
      .toEqual({ command: 'claude --resume abc12345', sessionId: 'abc12345' });
  });
  it('continue pins the latest id', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: null, sessionCount: 3, latestId: 'latest9', genId: gen }))
      .toEqual({ command: 'claude -c', sessionId: 'latest9' });
  });
  it('new (no sessions) => claude --session-id <uuid>', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: null, sessionCount: 0, latestId: null, genId: gen }))
      .toEqual({ command: `claude --session-id ${UUID}`, sessionId: UUID });
  });
  it('antigravity fresh: no --session-id support => plain new, id not pinned', () => {
    expect(resolveOpenSession(antigravity, { fresh: true, sessionId: null, sessionCount: 0, latestId: null, genId: gen }))
      .toEqual({ command: 'agy', sessionId: null });
  });
});

describe('cockpit:liveSessionId', () => {
  const projectPath = join(ALLOWED_ROOT, 'project');
  const opts = { currentId: 'current', claimedIds: [], openedAtMs: 1, sinceMs: 2, lastDataAtMs: 3 };

  it('uses the active provider\'s session store only when it supports drift detection', () => {
    const liveSessionId = handlers.get('cockpit:liveSessionId')!;

    storedAgent = 'claude';
    claudeStats.mockClear(); codexStats.mockClear();
    liveSessionId(null, projectPath, opts);
    expect(claudeStats).toHaveBeenCalledOnce();
    expect(codexStats).not.toHaveBeenCalled();

    storedAgent = 'codex';
    claudeStats.mockClear(); codexStats.mockClear();
    liveSessionId(null, projectPath, opts);
    expect(codexStats).toHaveBeenCalledOnce();
    expect(claudeStats).not.toHaveBeenCalled();

    storedAgent = 'antigravity';
    claudeStats.mockClear(); codexStats.mockClear();
    expect(liveSessionId(null, projectPath, opts)).toBeNull();
    expect(claudeStats).not.toHaveBeenCalled();
    expect(codexStats).not.toHaveBeenCalled();
  });
});
