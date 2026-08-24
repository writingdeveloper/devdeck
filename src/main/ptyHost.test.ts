import { describe, it, expect, vi } from 'vitest';
import { PtyHost, type PtyProcess, type PtySpawn } from './ptyHost';

function fakeProc() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const proc: PtyProcess & { emitData: (d: string) => void; emitExit: (c: number) => void } = {
    pid: 1234,
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    emitData: (d) => dataCb(d),
    emitExit: (c) => exitCb({ exitCode: c }),
  };
  return proc;
}

describe('PtyHost', () => {
  it('create() spawns with cwd/cols/rows and routes data to the per-id callback', () => {
    const proc = fakeProc();
    const spawn: PtySpawn = vi.fn(() => proc);
    const host = new PtyHost(spawn);
    const onData = vi.fn();
    host.create('id1', 'pwsh', ['-NoExit'], 'C:\\g\\p', 100, 30, onData, () => {});
    expect(spawn).toHaveBeenCalledWith('pwsh', ['-NoExit'], { cwd: 'C:\\g\\p', cols: 100, rows: 30 });
    proc.emitData('hello');
    expect(onData).toHaveBeenCalledWith('hello');
  });

  it('write/resize/kill delegate to the right process; killAll kills everything', () => {
    const a = fakeProc(), b = fakeProc();
    const spawn = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b) as unknown as PtySpawn;
    const host = new PtyHost(spawn);
    host.create('a', 'pwsh', [], 'C:\\a', 80, 24, () => {}, () => {});
    host.create('b', 'pwsh', [], 'C:\\b', 80, 24, () => {}, () => {});
    host.write('a', 'x'); expect(a.write).toHaveBeenCalledWith('x');
    host.resize('b', 120, 40); expect(b.resize).toHaveBeenCalledWith(120, 40);
    host.kill('a'); expect(a.kill).toHaveBeenCalled();
    host.killAll(); expect(b.kill).toHaveBeenCalled();
  });

  it('onExit fires the per-id callback and drops the process (write after exit is a no-op)', () => {
    const proc = fakeProc();
    const host = new PtyHost(vi.fn(() => proc) as unknown as PtySpawn);
    const onExit = vi.fn();
    host.create('id1', 'pwsh', [], 'C:\\g', 80, 24, () => {}, onExit);
    proc.emitExit(0);
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
    host.write('id1', 'x');
    expect(proc.write).not.toHaveBeenCalled();
  });
});

describe('what a machine can say about its own sessions', () => {
  const fake = () => {
    const listeners: ((d: string) => void)[] = [];
    const proc = {
      pid: 1, onData: (cb: (d: string) => void) => { listeners.push(cb); },
      onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {},
    };
    return { proc, emit: (d: string) => listeners.forEach((cb) => cb(d)) };
  };

  it('reports what each session IS, not just that one exists', () => {
    // A machine that knows it runs six terminals but nothing about them cannot answer the one
    // question another machine asks: what is already going on over there.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('C:\repo#1', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {},
      { projectPath: 'C:\repo', sessionId: 'conv-1', agentId: 'claude' });
    expect(host.list()).toEqual([expect.objectContaining({
      id: 'C:\repo#1', projectPath: 'C:\repo', sessionId: 'conv-1', agentId: 'claude',
    })]);
  });

  it('keeps recent output so an attaching viewer sees the screen, not a blank rectangle', () => {
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {});
    f.emit('first line\nbuilding…\n');
    f.emit('done\n');
    expect(host.buffer('s')).toContain('done');
  });

  it('drops the OLDEST output when the buffer fills — the recent part is what matters', () => {
    // A session streaming for hours must not hold every byte it ever produced, and the bytes worth
    // keeping are the ones about to be repainted.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {});
    for (let i = 0; i < 40; i++) f.emit('x'.repeat(10_000) + '\n');
    f.emit('THE-LATEST-LINE\n');
    const buffer = host.buffer('s');
    expect(buffer).toContain('THE-LATEST-LINE');
    expect(buffer.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('answers emptily for a session it does not have', () => {
    const host = new PtyHost(() => fake().proc);
    expect(host.buffer('nope')).toBe('');
    expect(host.list()).toEqual([]);
  });

  it('forgets a session once it exits, so the list never advertises a dead terminal', () => {
    let exit: (e: { exitCode: number }) => void = () => {};
    const proc = {
      pid: 1, onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => { exit = cb; },
      write: () => {}, resize: () => {}, kill: () => {},
    };
    const host = new PtyHost(() => proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {});
    expect(host.list()).toHaveLength(1);
    exit({ exitCode: 0 });
    expect(host.list()).toEqual([]);
  });

  it('records a conversation the tile drifted to after /clear', () => {
    const host = new PtyHost(() => fake().proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {}, { projectPath: 'C:\repo', sessionId: 'old', agentId: 'claude' });
    host.note('s', { sessionId: 'new' });
    expect(host.list()[0].sessionId).toBe('new');
    host.note('missing', { sessionId: 'x' }); // must not throw for a session that is gone
  });
});
