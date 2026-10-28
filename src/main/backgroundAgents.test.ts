import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));
// A bare `claude` keeps cliInvocation from wrapping the arguments in cmd.exe on Windows, so the
// tests can read the argv as written.
vi.mock('./cliExecutable', () => ({ resolveAgentCliPath: () => 'claude' }));

type Answer = { code: number; stderr?: string };
/** A `claude` that answers each invocation by its first words, like the real one on the PC. */
function fakeClaude(answer: (args: string[]) => Answer): void {
  spawn.mockImplementation((_file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: () => true, unref: () => undefined });
    const a = answer(args);
    setTimeout(() => {
      if (a.stderr) child.stderr.emit('data', Buffer.from(a.stderr));
      child.emit('close', a.code);
    }, 0);
    return child;
  });
}
const calls = (): string[] => spawn.mock.calls.map((c) => (c[1] as string[]).join(' '));

const LISTED = [{ id: '8e64da40', cwd: 'C:\\g\\shipwright', sessionId: '8e64da40-4c50-4e80-ae72-bddba02e6bcb', name: 'triage', state: 'blocked' as const, startedAt: 1 }];
const SERVICE_DOWN = "couldn't remove 8e64da40 — the background service may be restarting. Try again in a moment.";

describe('listing background sessions while Claude Code is being updated', () => {
  afterEach(async () => { const m = await import('./backgroundAgents.js'); await m.pauseBackgroundAgents(false); m._clearBackgroundAgentCache(); spawn.mockReset(); });

  it('starts no claude at all while paused — the update is replacing that executable', async () => {
    const m = await import('./backgroundAgents.js');
    await m.pauseBackgroundAgents(true);
    expect(await m.listBackgroundAgents()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('closing a background session when the background service is not running', () => {
  afterEach(() => { spawn.mockReset(); });

  it('stops and removes in one go while the service is up — nothing else is started', async () => {
    fakeClaude(() => ({ code: 0 }));
    const m = await import('./backgroundAgents.js');
    expect(await m.closeBackgroundAgent('8e64da40', LISTED)).toEqual({ ok: true });
    expect(calls()).toEqual(['stop 8e64da40', 'rm 8e64da40']);
  });

  it('starts the service the way Claude Code does and tries again when rm says it may be restarting', async () => {
    let serviceUp = false;
    fakeClaude((args) => {
      if (args[0] === 'daemon' && args[1] === 'run') { serviceUp = true; return { code: 0 }; }
      if (args[0] === 'daemon' && args[1] === 'status') return { code: serviceUp ? 0 : 1 };
      if (!serviceUp) return { code: 1, stderr: SERVICE_DOWN };
      return { code: 0 };
    });
    const m = await import('./backgroundAgents.js');
    expect(await m.closeBackgroundAgent('8e64da40', LISTED, { serviceWaitMs: 200 })).toEqual({ ok: true, serviceStarted: true });
    expect(calls()).toEqual(['stop 8e64da40', 'rm 8e64da40', 'daemon run --origin transient', 'daemon status', 'stop 8e64da40', 'rm 8e64da40']);
    // The service runs on after DevDeck, and on its own: detached, with no pipes to this process.
    const run = spawn.mock.calls.find((c) => (c[1] as string[])[1] === 'run')!;
    expect(run[2]).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('reports what rm said when the service never comes up — the message goes to the log, not away', async () => {
    fakeClaude((args) => (args[0] === 'daemon' && args[1] === 'run' ? { code: 0 } : { code: 1, stderr: SERVICE_DOWN }));
    const m = await import('./backgroundAgents.js');
    const result = await m.closeBackgroundAgent('8e64da40', LISTED, { serviceWaitMs: 50 });
    expect(result).toMatchObject({ ok: false, error: 'failed' });
    expect((result as { detail?: string }).detail).toContain('may be restarting');
    expect(calls().filter((c) => c === 'rm 8e64da40')).toHaveLength(1); // no second try without a service
  });

  it('counts a session that is already gone as closed', async () => {
    fakeClaude((args) => (args[0] === 'rm' ? { code: 1, stderr: "No job matching '8e64da40'" } : { code: 1 }));
    const m = await import('./backgroundAgents.js');
    expect(await m.closeBackgroundAgent('8e64da40', LISTED)).toEqual({ ok: true });
    expect(calls()).toEqual(['stop 8e64da40', 'rm 8e64da40']);
  });

  it('acts only on an id the listing shows, and only on a short hex one', async () => {
    fakeClaude(() => ({ code: 0 }));
    const m = await import('./backgroundAgents.js');
    expect(await m.closeBackgroundAgent('00cf1408', LISTED)).toEqual({ ok: false, error: 'not-listed' });
    expect(await m.closeBackgroundAgent('8e64da40; rm -rf /', LISTED)).toEqual({ ok: false, error: 'bad-id' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('listing off the job records before starting a claude process', () => {
  const LISTING = JSON.stringify([{ id: '8e64da40', cwd: 'C:/g/shipwright', kind: 'background', startedAt: 1, sessionId: '8e64da40-4c50-4e80-ae72-bddba02e6bcb', name: 'triage', state: 'blocked' }]);
  const dirs: string[] = [];
  const jobsDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'devdeck-jobs-')); dirs.push(d); return d; };
  const record = (dir: string, id: string, body = '{}'): void => { mkdirSync(join(dir, id), { recursive: true }); writeFileSync(join(dir, id, 'state.json'), body); };
  afterEach(async () => {
    const m = await import('./backgroundAgents.js'); m._clearBackgroundAgentCache(); spawn.mockReset();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('with no records (or no folder) still asks claude once, then reuses the answer for five minutes', async () => {
    // The records only stretch the cache: a claude that keeps its records elsewhere (or a fake one
    // in a harness) must still be asked — just not every poll.
    fakeClaude(() => ({ code: 0 }));
    const m = await import('./backgroundAgents.js');
    const dir = jobsDir();
    writeFileSync(join(dir, 'pins.json'), '[]'); // not a record
    const t0 = Date.now();
    expect(await m.listBackgroundAgents(t0, { jobsDir: dir })).toEqual([]);
    expect(calls()).toEqual(['agents --json --all']);
    expect(await m.listBackgroundAgents(t0 + 60_000, { jobsDir: dir })).toEqual([]);
    expect(await m.listBackgroundAgents(t0 + 240_000, { jobsDir: join(dir, 'missing') })).toEqual([]);
    expect(calls()).toHaveLength(1);
    expect(await m.listBackgroundAgents(t0 + 6 * 60_000, { jobsDir: dir })).toEqual([]);
    expect(calls()).toHaveLength(2);
  });

  it('runs the listing when a record exists, and not again while the records are unchanged', async () => {
    spawn.mockImplementation((_file: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1, kill: () => true, unref: () => undefined });
      setTimeout(() => { if (args[0] === 'agents') child.stdout.emit('data', Buffer.from(LISTING)); child.emit('close', 0); }, 0);
      return child;
    });
    const m = await import('./backgroundAgents.js');
    const dir = jobsDir();
    record(dir, '8e64da40');
    const t0 = Date.now();
    const first = await m.listBackgroundAgents(t0, { jobsDir: dir });
    expect(first.map((b) => b.id)).toEqual(['8e64da40']);
    expect(calls()).toEqual(['agents --json --all']);
    // Past the short cache, same records: the last answer, no process.
    expect(await m.listBackgroundAgents(t0 + 60_000, { jobsDir: dir })).toBe(first);
    expect(calls()).toHaveLength(1);
    // A record changed (the session moved on, or one was added): the listing runs again.
    record(dir, '8e64da40', '{"state":"idle"}');
    expect(await m.listBackgroundAgents(t0 + 120_000, { jobsDir: dir })).toEqual(first);
    expect(calls()).toHaveLength(2);
    // Unchanged for longer than the reuse window: listed again regardless.
    expect(await m.listBackgroundAgents(t0 + 120_000 + 6 * 60_000, { jobsDir: dir })).toEqual(first);
    expect(calls()).toHaveLength(3);
  });

  it('signs the records by name, change time and size, ignoring other files', async () => {
    const m = await import('./backgroundAgents.js');
    const dir = jobsDir();
    writeFileSync(join(dir, 'pins.json'), '[]');
    expect(await m.jobRecordsSignature(dir)).toBe('');
    record(dir, 'b54cc363', '{"a":1}');
    record(dir, '09644674', '{"a":1}');
    const sig = await m.jobRecordsSignature(dir);
    expect(sig).toMatch(/^09644674:\d+:7\|b54cc363:\d+:7$/);
    expect(await m.jobRecordsSignature(join(dir, 'nope'))).toBe('');
  });
});
