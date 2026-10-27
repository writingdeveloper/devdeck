import { EventEmitter } from 'node:events';
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
