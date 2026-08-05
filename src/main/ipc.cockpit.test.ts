import { beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const { handlers, claudeStats, codexStats, codexIndex, claudeIds, probe } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  claudeStats: vi.fn(() => []),
  codexStats: vi.fn(() => []),
  codexIndex: vi.fn(() => new Map<string, { id: string; mtimeMs: number; firstMessage: string | null }[]>()),
  claudeIds: vi.fn((_projectPath: string, _dir: string): string[] => []),
  // The real prober spawns a process listing; the handler's contract (resolve the tile's pid, answer
  // null when there is no pty) is what this file checks.
  probe: vi.fn(async (_pid: number): Promise<string | null> => 'claude'),
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

vi.mock('./sessions', () => ({
  listSessionStats: claudeStats,
  // Stubbed reads (see the Codex mock below): the Claude provider is exercised for its launch commands,
  // never against a real ~/.claude store.
  listSessions: async () => [],
  listSessionIds: claudeIds,
  lastUserMessageForSession: async () => null,
}));
vi.mock('./codexSessions', () => ({
  listCodexSessionStats: codexStats,
  indexCodexSessionsByCwd: codexIndex,
  // The Codex provider itself is exercised through agents.ts (launch-command resolution) — stub its
  // reads so the test never depends on a real ~/.codex store.
  codexAvailable: () => true,
  listCodexSessions: () => [{ id: 'x1', mtimeMs: 10, firstMessage: null }],
  listCodexSessionIds: () => ['x1'],
  lastUserMessageForCodexSession: () => null,
  readCodexSessionMeta: () => ({
    assistantText: '설정 저장 로직을 정리했습니다', editedFiles: ['store.ts'], userText: '계속',
    model: 'gpt-5.6-sol', contextTokens: 130_848, contextWindow: 258_400, mtimeMs: 42,
  }),
}));
vi.mock('./antigravitySessions', () => ({ indexAntigravitySessionsByCwd: () => new Map() }));
vi.mock('./agentProcess', () => ({ makeAgentProbe: () => probe }));
// Which agents are "installed" must not depend on the test machine's home directory.
vi.mock('./agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agents')>()),
  availableAgents: () => ['claude', 'codex'],
}));

import { registerIpc, type IpcConfig } from './ipc';
import { getProvider, resolveOpenSession } from './agents';
import { cwdKey } from '../shared/paths';

const ALLOWED_ROOT = join(process.cwd(), 'cockpit-allowed-root');
let storedAgent = 'claude';
const ptyCreate = vi.fn();

beforeAll(() => {
  registerIpc({
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: {
      getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }], getAgent: () => storedAgent,
      getSessionSummary: () => true, getAiSessionSummary: () => false,
    },
    sendError: vi.fn(),
    defaultLanguage: 'en',
    ptyHost: { create: ptyCreate, pid: (id: string) => (id === 'live#1' ? 4321 : null) },
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

// A session belongs to the provider it was opened with: flipping the global selection must NOT hand a
// Claude conversation to `codex` on restore/restart/"+ new session" (the multi-provider mix-up bug).
describe('session-scoped provider', () => {
  const projectPath = join(ALLOWED_ROOT, 'project');
  const launchCommand = () => String((ptyCreate.mock.calls.at(-1)![2] as string[])[2]);

  it('cockpit:open honors the request\'s agentId over the globally selected agent', async () => {
    const open = handlers.get('cockpit:open')!;
    storedAgent = 'codex';

    ptyCreate.mockClear();
    await open(null, { projectPath, sessionId: null, cols: 80, rows: 24, fresh: true, agentId: 'claude' });
    expect(launchCommand()).toMatch(/^claude --session-id /);

    ptyCreate.mockClear();
    await open(null, { projectPath, sessionId: null, cols: 80, rows: 24, fresh: true, agentId: 'antigravity' });
    expect(launchCommand()).toBe('agy');

    // No agentId (a plain deck open) still follows the global selection.
    ptyCreate.mockClear();
    await open(null, { projectPath, sessionId: null, cols: 80, rows: 24, fresh: true });
    expect(launchCommand()).toBe('codex');
  });

  // A caller with NO session context (the task board's ▶, a freshly created project) used to launch
  // whatever the header selector said — which handed one provider's project to another agent. The
  // project's own most recent conversation decides instead.
  it('infers the project\'s own provider when the caller sends no agentId', async () => {
    const open = handlers.get('cockpit:open')!;
    storedAgent = 'claude'; // selection says Claude, but this project's history is Codex
    codexIndex.mockReturnValue(new Map([[cwdKey(projectPath), [{ id: 'x1', mtimeMs: 10, firstMessage: null }]]]));

    ptyCreate.mockClear();
    await open(null, { projectPath, sessionId: null, cols: 80, rows: 24 });
    expect(launchCommand()).toBe('codex resume --last');

    // An explicit agentId still wins over the inference.
    ptyCreate.mockClear();
    await open(null, { projectPath, sessionId: null, cols: 80, rows: 24, agentId: 'claude' });
    expect(launchCommand()).toMatch(/^claude/);
    codexIndex.mockReturnValue(new Map());
  });

  it('cockpit:liveSessionId reads the OWNING provider\'s session store', () => {
    const liveSessionId = handlers.get('cockpit:liveSessionId')!;
    storedAgent = 'codex';
    claudeStats.mockClear(); codexStats.mockClear();
    liveSessionId(null, projectPath, { currentId: null, claimedIds: [], openedAtMs: 1, sinceMs: 2, lastDataAtMs: 3, agentId: 'claude' });
    expect(claudeStats).toHaveBeenCalledOnce();
    expect(codexStats).not.toHaveBeenCalled();
  });
});

// A tile's shell outlives the agent it was opened with (`-NoExit`), so the provider has to be re-read
// from what is RUNNING — otherwise a tile where the user typed `claude` after `codex resume` finished
// keeps reporting Codex, and its usage/session reads go to the wrong store.
describe('cockpit:liveAgent', () => {
  it('probes the tile\'s own pty process, and answers null when the tile has no pty', async () => {
    const liveAgent = handlers.get('cockpit:liveAgent')!;

    probe.mockClear();
    expect(await liveAgent(null, 'live#1')).toBe('claude');
    expect(probe).toHaveBeenCalledWith(4321);

    probe.mockClear();
    expect(await liveAgent(null, 'gone#9')).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('a failing probe is null, never a wrong provider', async () => {
    const liveAgent = handlers.get('cockpit:liveAgent')!;
    probe.mockRejectedValueOnce(new Error('no process listing'));
    expect(await liveAgent(null, 'live#1')).toBeNull();
  });
});

describe('cockpit:liveSessionId', () => {
  const projectPath = join(ALLOWED_ROOT, 'project');
  const opts = { currentId: 'current', claimedIds: [], openedAtMs: 1, sinceMs: 2, lastDataAtMs: 3 };

  it('falls back to the active provider when the caller has no session context', () => {
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

// The summary line is provider-aware: Claude reads its .jsonl, Codex a bounded tail of its rollout,
// and a provider with no readable transcript (Antigravity) simply gets no line.
describe('cockpit:sessionMeta summary per provider', () => {
  const projectPath = join(ALLOWED_ROOT, 'project');
  const SESSION = '019f91b2-fa6d-7971-b19d-c07092dcfc57';

  it('summarizes a Codex session from its rollout, with its own model and context window', () => {
    const out = handlers.get('cockpit:sessionMeta')!(null, projectPath, SESSION, 'codex') as Record<string, unknown>;
    expect(out).toMatchObject({
      summary: '설정 저장 로직을 정리했습니다',
      summarySource: 'assistant',
      model: 'gpt-5.6-sol',
      contextTokens: 130_848,
      contextWindow: 258_400, // the renderer measures the 🧠 % against THIS, not the global setting
      activeMs: 0, // no Codex equivalent
    });
  });

  it('returns the neutral shape for a provider with no transcript reader', () => {
    expect(handlers.get('cockpit:sessionMeta')!(null, projectPath, SESSION, 'antigravity'))
      .toEqual({ model: null, activeMs: 0, contextTokens: 0, contextWindow: 0, summary: null, summarySource: null });
  });
});

// A saved entry names ONE conversation. When that conversation is gone the tile comes back as a fresh
// session under the same name (resolveRestoreTarget) — so the "Previous" list has to be able to say so
// BEFORE the click. This answers the whole list at once: per-entry would re-index the flat Codex
// rollout store once per project.
describe('cockpit:sessionsExist', () => {
  const projectPath = join(ALLOWED_ROOT, 'project');
  const other = join(ALLOWED_ROOT, 'other');

  it('reports only what it is SURE is missing', async () => {
    const sessionsExist = handlers.get('cockpit:sessionsExist')!;
    claudeIds.mockImplementation((p: string) => (p === projectPath ? ['kept'] : []));
    codexIndex.mockReturnValue(new Map([[cwdKey(projectPath), [{ id: 'cx-kept', mtimeMs: 1, firstMessage: null }]]]));

    expect(await sessionsExist(null, [
      { projectPath, sessionId: 'kept', agentId: 'claude' },
      { projectPath, sessionId: 'deleted', agentId: 'claude' },
      { projectPath, sessionId: 'cx-kept', agentId: 'codex' },
      { projectPath, sessionId: 'cx-gone', agentId: 'codex' },
      // Antigravity records no per-tile id, and an unlisted path can't be read — neither may be
      // reported as gone, or the row would warn about something it never checked.
      { projectPath, sessionId: 'whatever', agentId: 'antigravity' },
      { projectPath: join(process.cwd(), 'outside'), sessionId: 'x', agentId: 'claude' },
      { projectPath, sessionId: null, agentId: 'claude' },
      'not an entry',
    ])).toEqual([true, false, true, false, true, true, true, true]);
  });

  it('reads each store once for the whole list, not once per entry', async () => {
    const sessionsExist = handlers.get('cockpit:sessionsExist')!;
    claudeIds.mockClear(); codexIndex.mockClear();
    claudeIds.mockImplementation(() => []);
    codexIndex.mockReturnValue(new Map());

    await sessionsExist(null, [
      { projectPath, sessionId: 'a', agentId: 'claude' },
      { projectPath, sessionId: 'b', agentId: 'claude' }, // same project → memoized
      { other: 1, projectPath: other, sessionId: 'c', agentId: 'claude' },
      { projectPath, sessionId: 'd', agentId: 'codex' },
      { projectPath: other, sessionId: 'e', agentId: 'codex' },
    ]);
    expect(claudeIds).toHaveBeenCalledTimes(2); // one per distinct project, not per entry
    expect(codexIndex).toHaveBeenCalledTimes(1); // the flat store is indexed ONCE for every codex entry
  });

  it('is bounded and tolerates a non-array payload', async () => {
    const sessionsExist = handlers.get('cockpit:sessionsExist')!;
    expect(await sessionsExist(null, null)).toEqual([]);
    const many = Array.from({ length: 250 }, () => ({ projectPath, sessionId: 'a', agentId: 'claude' }));
    expect(((await sessionsExist(null, many)) as boolean[]).length).toBe(200);
  });
});
