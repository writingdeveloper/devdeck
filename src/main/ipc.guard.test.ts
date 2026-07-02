import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'node:path';

// Capture handler registrations instead of a real ipcMain so each channel can be invoked directly.
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); },
    on: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); },
  },
  dialog: {},
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

const ALLOWED_ROOT = join(process.cwd(), 'allowed-root');
const sendError = vi.fn();
const applyCounts = vi.fn();

beforeAll(() => {
  const cfg = {
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: { getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }], getTrayAlert: () => 'attention' },
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
