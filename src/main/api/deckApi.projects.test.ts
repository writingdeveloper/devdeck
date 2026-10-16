import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitInfo, StoreEntry } from '../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  clipboard: { readImage: vi.fn() },
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
}));

// git is what makes a deck list slow; a counted, controllable stand-in shows how many lists ran it.
const { gitCalls, gitGate } = vi.hoisted(() => ({ gitCalls: [] as string[], gitGate: { release: null as null | (() => void) } }));
vi.mock('../gitInfo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gitInfo')>()),
  getGitInfo: async (dir: string): Promise<GitInfo> => {
    gitCalls.push(dir);
    if (gitGate.release === null) await new Promise<void>((resolve) => { gitGate.release = resolve; });
    return { branch: 'main', lastCommitMs: 1_000, lastSubject: 'x', uncommitted: 0, ahead: null, repoUrl: null };
  },
}));

import { createDeckApi, type DeckApiConfig } from './deckApi';
import type { DeckApi } from './methods';

let root: string;
let api: DeckApi;
const entries = new Map<string, Partial<StoreEntry>>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'devdeck-deck-'));
  mkdirSync(join(root, 'alpha', '.git'), { recursive: true });
  mkdirSync(join(root, 'beta', '.git'), { recursive: true });
  api = createDeckApi({
    win: { on: () => {}, isDestroyed: () => true, webContents: { send: () => {} } },
    defaultBaseDir: root,
    store: {
      getFolders: () => [{ path: root, kind: 'root' }],
      getThresholds: () => null,
      get: (p: string): StoreEntry => ({ note: '', pinned: false, hidden: false, lastOpened: null, todos: [], ...entries.get(p) }),
      getSessionSummary: () => true,
      getAiSessionSummary: () => false,
    },
    sendError: vi.fn(),
    defaultLanguage: 'en',
    ptyHost: { list: () => [] },
    ptyAvailable: true,
    tray: { applyCounts: vi.fn(), setAlertImage: vi.fn() },
    shutdown: null,
    bootTimeMs: () => 0,
  } as unknown as DeckApiConfig).methods;
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
beforeEach(() => { gitCalls.length = 0; gitGate.release = null; entries.clear(); });

type Row = { path: string; pinned: boolean; note: string };
const list = (): Promise<Row[]> => api['projects:list'].handler() as Promise<Row[]>;
const until = async (cond: () => boolean): Promise<void> => { while (!cond()) await new Promise((r) => setTimeout(r, 1)); };

describe('projects:list', () => {
  it('lists asked for while one is being built share its git work', async () => {
    const first = list();
    await until(() => gitGate.release !== null); // the first list is now waiting on git
    const second = list();
    const third = list();
    gitGate.release!();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(gitCalls.sort()).toEqual([join(root, 'alpha'), join(root, 'beta')]); // once per project, not three times
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a).not.toBe(b); // each caller gets rows of its own
  });

  it('a pin or note changed while a shared list is building shows in every answer', async () => {
    const first = list();
    await until(() => gitGate.release !== null);
    const second = list();
    entries.set(join(root, 'beta'), { pinned: true, note: 'changed mid-build' });
    gitGate.release!();
    for (const rows of await Promise.all([first, second])) {
      expect(rows[0]).toMatchObject({ path: join(root, 'beta'), pinned: true, note: 'changed mid-build' });
    }
  });

  it('a list asked for after one finished runs git again', async () => {
    gitGate.release = () => {}; // no gate: git answers at once
    await list();
    await list();
    expect(gitCalls).toHaveLength(4);
  });
});
