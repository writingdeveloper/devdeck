import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { whereOutput } = vi.hoisted(() => ({ whereOutput: vi.fn((): string => '') }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => Buffer.from(whereOutput())) }));

import { execFileSync } from 'node:child_process';
import { resolveAgentCliPath, _clearCliPathCache } from './cliExecutable';

let dir: string;
// The per-user install locations are checked after `where`; point them at an empty dir so what is
// installed on the machine running the tests cannot answer for the stub.
const SAVED = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devdeck-cli-'));
  Object.assign(process.env, { APPDATA: dir, LOCALAPPDATA: dir, USERPROFILE: dir });
  _clearCliPathCache();
  vi.mocked(execFileSync).mockClear();
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// `where` is a synchronous child process (~50 ms of a frozen main process); the Codex usage refresh
// asked it on every poll.
describe('resolveAgentCliPath lookup cache', () => {
  it('runs `where` once for repeated asks, and again once the found file is gone', () => {
    const exe = join(dir, 'codex.cmd');
    writeFileSync(exe, '');
    whereOutput.mockReturnValue(`${exe}\r\n`);
    expect(resolveAgentCliPath('codex', process.env, 'win32')).toBe(exe);
    expect(resolveAgentCliPath('codex', process.env, 'win32')).toBe(exe);
    expect(execFileSync).toHaveBeenCalledTimes(1);

    rmSync(exe); // uninstalled: the remembered path must not be handed out
    whereOutput.mockReturnValue('');
    expect(resolveAgentCliPath('codex', process.env, 'win32')).toBe('codex');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('never remembers a miss — a CLI installed later is found on the next ask', () => {
    whereOutput.mockReturnValue('');
    const env = process.env;
    const before = resolveAgentCliPath('claude', env, 'win32');
    resolveAgentCliPath('claude', env, 'win32');
    expect(execFileSync).toHaveBeenCalledTimes(2);
    const exe = join(dir, 'claude.exe');
    writeFileSync(exe, '');
    whereOutput.mockReturnValue(exe);
    expect(resolveAgentCliPath('claude', env, 'win32')).toBe(exe);
    expect(before).not.toBe(exe);
  });

  it('does not cache lookups made with an injected environment or existence check', () => {
    const exe = join(dir, 'codex.exe');
    writeFileSync(exe, '');
    whereOutput.mockReturnValue(exe);
    const exists = (): boolean => true;
    resolveAgentCliPath('codex', process.env, 'win32', exists);
    resolveAgentCliPath('codex', process.env, 'win32', exists);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('is not consulted off Windows', () => {
    expect(resolveAgentCliPath('codex', process.env, 'linux')).toBe('codex');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
