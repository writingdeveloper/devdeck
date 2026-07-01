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

beforeAll(() => {
  const cfg = {
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: ALLOWED_ROOT,
    store: { getFolders: () => [{ path: ALLOWED_ROOT, kind: 'root' }] },
    sendError,
    defaultLanguage: 'en',
    ptyHost: {},
    tray: {},
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
