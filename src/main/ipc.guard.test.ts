import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'node:path';

// Capture handler registrations instead of a real ipcMain so each channel can be invoked directly.
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); },
    on: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); },
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  clipboard: {},
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
}));

vi.mock('./gitInfo', () => ({
  getGitInfo: vi.fn(),
  getRepoUrl: vi.fn(),
  getGitBranchDirty: vi.fn(() => ({ branch: 'main', dirty: 2 })),
}));

import { registerIpc, type IpcConfig } from './ipc';
import { getGitBranchDirty } from './gitInfo';
import { dialog } from 'electron';

const ALLOWED_ROOT = join(process.cwd(), 'allowed-root');
const sendError = vi.fn();
const applyCounts = vi.fn();
const storeSpies = { setNote: vi.fn(), setTodos: vi.fn(), setPinned: vi.fn(), setHidden: vi.fn(), addFolder: vi.fn() };

beforeAll(() => {
  const cfg = {
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: {
      getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }], getTrayAlert: () => 'attention',
      ...storeSpies,
    },
    sendError,
    defaultLanguage: 'en',
    ptyHost: {},
    tray: { applyCounts, setAlertImage: vi.fn() },
  } as unknown as IpcConfig;
  registerIpc(cfg);
});

describe('cockpit:gitInfo path guard', () => {
  it('refuses a path outside the allowed folders without touching git', () => {
    vi.mocked(getGitBranchDirty).mockClear();
    const out = handlers.get('cockpit:gitInfo')!(null, join(process.cwd(), 'elsewhere', 'repo'));
    expect(out).toBeNull();
    expect(getGitBranchDirty).not.toHaveBeenCalled();
  });

  it('serves branch+dirty for a project under an allowed folder', () => {
    vi.mocked(getGitBranchDirty).mockClear();
    const p = join(ALLOWED_ROOT, 'my-proj');
    const out = handlers.get('cockpit:gitInfo')!(null, p);
    expect(out).toEqual({ branch: 'main', dirty: 2 });
    expect(getGitBranchDirty).toHaveBeenCalledWith(p);
  });
});

describe('project store-setter path guards', () => {
  // setNote/setTodos/setPinned/setHidden write to state.json keyed by an arbitrary path string. Without
  // the same allowlist every other path-taking handler uses, a compromised renderer could grow the
  // store unboundedly with keys outside any scanned folder. Legit deck writes are always in-allowlist.
  const outside = join(process.cwd(), 'elsewhere', 'proj');
  const inside = join(ALLOWED_ROOT, 'proj');

  it('ignores writes to a path outside the allowed folders', () => {
    for (const s of Object.values(storeSpies)) s.mockClear();
    handlers.get('project:setNote')!(null, outside, 'x');
    handlers.get('project:setTodos')!(null, outside, []);
    handlers.get('project:setPinned')!(null, outside, true);
    handlers.get('project:setHidden')!(null, outside, true);
    expect(storeSpies.setNote).not.toHaveBeenCalled();
    expect(storeSpies.setTodos).not.toHaveBeenCalled();
    expect(storeSpies.setPinned).not.toHaveBeenCalled();
    expect(storeSpies.setHidden).not.toHaveBeenCalled();
  });

  it('allows writes to a project under an allowed folder', () => {
    for (const s of Object.values(storeSpies)) s.mockClear();
    handlers.get('project:setNote')!(null, inside, 'hi');
    handlers.get('project:setPinned')!(null, inside, true);
    handlers.get('project:setHidden')!(null, inside, true);
    expect(storeSpies.setNote).toHaveBeenCalledWith(inside, 'hi');
    expect(storeSpies.setPinned).toHaveBeenCalledWith(inside, true);
    expect(storeSpies.setHidden).toHaveBeenCalledWith(inside, true);
  });
});

describe('cockpit read-path guards', () => {
  // The guard returns before the provider is touched, so a disallowed path yields each handler's neutral
  // shape without leaking session ids / model / time / context for projects outside a scanned folder.
  it('returns empty/neutral for a path outside the allowed folders', () => {
    const outside = join(process.cwd(), 'elsewhere', 'proj');
    expect(handlers.get('cockpit:sessionIds')!(null, outside)).toEqual([]);
    expect(handlers.get('cockpit:sessionMeta')!(null, outside, 'some-sid'))
      .toEqual({ model: null, activeMs: 0, contextTokens: 0 });
  });
});

describe('tray:counts partial merge', () => {
  // Two independent senders share this channel: the cockpit sends {attention, turn} on session
  // activity, the deck sends {overdue} on task changes. Each must update only its own fields —
  // a whole-object overwrite would zero the other sender's counts on every message.
  it('keeps the other sender\'s fields when a partial update arrives', () => {
    applyCounts.mockClear();
    handlers.get('tray:counts')!(null, { attention: 2, turn: 1 });
    handlers.get('tray:counts')!(null, { overdue: 3 });
    expect(applyCounts).toHaveBeenLastCalledWith({ attention: 2, turn: 1, overdue: 3 }, 'attention');
    handlers.get('tray:counts')!(null, { attention: 0, turn: 0 });
    expect(applyCounts).toHaveBeenLastCalledWith({ attention: 0, turn: 0, overdue: 3 }, 'attention');
  });

  it('sanitizes junk to non-negative integers', () => {
    applyCounts.mockClear();
    handlers.get('tray:counts')!(null, { attention: -5, turn: 'x', overdue: 2.9 });
    expect(applyCounts).toHaveBeenLastCalledWith({ attention: 0, turn: 0, overdue: 2 }, 'attention');
  });
});

describe('settings:addFolder picker handshake', () => {
  // addFolder WIDENS the scan allowlist every other path guard relies on, so it must refuse any path
  // the renderer names itself and accept only one the user chose through the native dialog.
  it('refuses a renderer-named path that never came from pickFolder', async () => {
    storeSpies.addFolder.mockClear(); sendError.mockClear();
    await handlers.get('settings:addFolder')!(null, join(process.cwd(), 'attacker-named'));
    expect(storeSpies.addFolder).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(1);
  });

  it('accepts a directory returned by pickFolder, and only once (single-use bless)', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [process.cwd()] } as never);
    const picked = await handlers.get('settings:pickFolder')!(null);
    expect(picked).toBe(process.cwd());

    storeSpies.addFolder.mockClear();
    await handlers.get('settings:addFolder')!(null, process.cwd());
    expect(storeSpies.addFolder).toHaveBeenCalledWith({ path: process.cwd(), kind: expect.any(String) });

    // The bless is consumed — a second addFolder for the same path is refused.
    storeSpies.addFolder.mockClear();
    await handlers.get('settings:addFolder')!(null, process.cwd());
    expect(storeSpies.addFolder).not.toHaveBeenCalled();
  });
});
