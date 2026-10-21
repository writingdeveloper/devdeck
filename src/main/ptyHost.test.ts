import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PtyHost, MAX_SESSIONS, taskkillTree, withTreeKill, type PtyProcess, type PtySpawn } from './ptyHost';

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
  it('waits for already-closing terminals and rejects new opens during shutdown', async () => {
    const a = fakeProc(), b = fakeProc();
    const host = new PtyHost(vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b));
    host.create('a', 'cmd', [], '.', 80, 24, () => {}, () => {});
    host.create('b', 'cmd', [], '.', 80, 24, () => {}, () => {});
    host.kill('a');
    const work = host.shutdown();
    expect(host.shutdown()).toBe(work);
    expect(a.kill).toHaveBeenCalledTimes(1);
    expect(b.kill).not.toHaveBeenCalled(); // waits for a to finish exiting
    expect(() => host.create('c', 'cmd', [], '.', 80, 24, () => {}, () => {})).toThrow('shutting down');
    let finished = false;
    void work.then(() => { finished = true; });
    a.emitExit(0);
    await vi.waitFor(() => expect(b.kill).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    b.emitExit(0);
    await work;
    expect(finished).toBe(true);
  });

  it('bounds shutdown when a native terminal never sends exit', async () => {
    vi.useFakeTimers();
    try {
      const host = new PtyHost(() => fakeProc());
      host.create('a', 'cmd', [], '.', 80, 24, () => {}, () => {});
      const result = expect(host.shutdown(100)).rejects.toThrow('terminal shutdown');
      await vi.advanceTimersByTimeAsync(100);
      await result;
    } finally { vi.useRealTimers(); }
  });

  it('an old terminal exit cannot remove a replacement with the same id', () => {
    const a = fakeProc(), b = fakeProc();
    const host = new PtyHost(vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b));
    host.create('same', 'cmd', [], '.', 80, 24, () => {}, () => {});
    host.kill('same');
    host.create('same', 'cmd', [], '.', 80, 24, () => {}, () => {});
    a.emitExit(0);
    host.write('same', 'still here');
    expect(b.write).toHaveBeenCalledWith('still here');
  });

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

  it('write/resize/kill delegate to the right process; killAll kills everything', async () => {
    const a = fakeProc(), b = fakeProc();
    const spawn = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b) as unknown as PtySpawn;
    const host = new PtyHost(spawn);
    host.create('a', 'pwsh', [], 'C:\\a', 80, 24, () => {}, () => {});
    host.create('b', 'pwsh', [], 'C:\\b', 80, 24, () => {}, () => {});
    host.write('a', 'x'); expect(a.write).toHaveBeenCalledWith('x');
    host.resize('b', 120, 40); expect(b.resize).toHaveBeenCalledWith(120, 40);
    host.kill('a'); expect(a.kill).toHaveBeenCalled();
    host.killAll(); expect(b.kill).not.toHaveBeenCalled();
    a.emitExit(0);
    await vi.waitFor(() => expect(b.kill).toHaveBeenCalled());
  });

  it('ends terminals one at a time, each after the previous exit (node-pty races two exits on Windows)', async () => {
    vi.useFakeTimers();
    try {
      const procs = [fakeProc(), fakeProc(), fakeProc()];
      const spawn = vi.fn();
      for (const p of procs) spawn.mockReturnValueOnce(p);
      const host = new PtyHost(spawn as unknown as PtySpawn);
      for (const id of ['a', 'b', 'c']) host.create(id, 'pwsh', [], '.', 80, 24, () => {}, () => {});
      host.killAll();
      const killed = () => procs.map((p) => (p.kill as ReturnType<typeof vi.fn>).mock.calls.length);
      expect(killed()).toEqual([1, 0, 0]);
      procs[0].emitExit(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(killed()).toEqual([1, 1, 0]);
      // A terminal that never reports its exit holds the next one up only for a while.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(killed()).toEqual([1, 1, 1]);
    } finally { vi.useRealTimers(); }
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
    expect(host.buffer('s').data).toBe('first line\nbuilding…\ndone\n');
  });

  it('drops the OLDEST output when the buffer fills — the recent part is what matters', () => {
    // A session streaming for hours must not hold every byte it ever produced, and the bytes worth
    // keeping are the ones about to be repainted.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {});
    for (let i = 0; i < 40; i++) f.emit('x'.repeat(10_000) + '\n');
    f.emit('THE-LATEST-LINE\n');
    const buffer = host.buffer('s').data;
    expect(buffer).toContain('THE-LATEST-LINE');
    expect(buffer.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('reports the size its remembered output was drawn for', () => {
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:/repo', 120, 40, () => {}, () => {});
    f.emit('first\nhello\n');
    expect(host.buffer('s')).toEqual({ data: expect.stringContaining('hello'), cols: 120, rows: 40 });
  });

  it('does not replay a truncated escape prefix until a complete line boundary exists', () => {
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:/repo', 80, 24, () => {}, () => {});
    f.emit('x'.repeat(300_000));
    expect(host.buffer('s').data).toBe('');
    f.emit('\x1b[Hfull screen repaint');
    expect(host.buffer('s').data).toBe('\x1b[Hfull screen repaint');
    f.emit('\ncomplete line\n');
    expect(host.buffer('s').data).toBe('complete line\n');
    host.resize('s', 100, 30);
    f.emit('\x1b[Hfirst repaint row\nsecond row\n');
    expect(host.buffer('s').data).toBe('\x1b[Hfirst repaint row\nsecond row\n');
  });

  it('forgets output drawn at the old size when the size changes', () => {
    // The bug this exists for: ConPTY paints by absolute cursor address, computed for the width it
    // had at the time. Handing a viewer bytes drawn at 120 columns to replay into an 80-column
    // terminal puts every one of those writes in the wrong place, and the wider paint underneath
    // shows through — reported as a terminal split down the middle. Bytes and geometry travel
    // together or not at all.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('s', 'pwsh', [], 'C:/repo', 120, 40, () => {}, () => {});
    f.emit('first\ndrawn-at-120-columns\n');
    expect(host.resize('s', 80, 30)).toBe(true);
    expect(host.buffer('s')).toEqual({ data: '', cols: 80, rows: 30 });
    f.emit('first\nrepainted-at-80\n');
    expect(host.buffer('s').data).toContain('repainted-at-80');
  });

  it('drops a resize to the size it already has, rather than making conpty repaint for nothing', () => {
    // Every resize costs a full screen repaint, fanned out to every attached terminal on every
    // machine watching. Re-asserting an unchanged size buys none of that back.
    const proc = fakeProc();
    const host = new PtyHost(() => proc);
    host.create('s', 'pwsh', [], 'C:/repo', 120, 40, () => {}, () => {});
    proc.emitData('first\nkeep-me\n');
    expect(host.resize('s', 120, 40)).toBe(false);
    expect(proc.resize).not.toHaveBeenCalled();
    expect(host.buffer('s').data).toContain('keep-me'); // and the screen it already had survives
    expect(host.resize('s', 120, 41)).toBe(true); // a real change still goes through
    expect(proc.resize).toHaveBeenCalledWith(120, 41);
  });

  it('answers emptily for a session it does not have', () => {
    const host = new PtyHost(() => fake().proc);
    expect(host.buffer('nope').data).toBe('');
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

  it('carries the name the user gave a session, so a viewer is not left with the folder name', () => {
    // Two sessions on ONE repository are told apart by nothing else: without the name travelling with
    // the session, a deck watching this machine shows two identical rows.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('a', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {}, { projectPath: 'C:\repo', sessionId: 'c1', agentId: 'claude' });
    host.create('b', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {}, { projectPath: 'C:\repo', sessionId: 'c2', agentId: 'claude', label: 'release prep' });
    expect(host.list().map((s) => s.label)).toEqual([null, 'release prep']);
    host.note('a', { label: 'bug hunt' });
    expect(host.list()[0].label).toBe('bug hunt');
    host.note('a', { label: null }); // cleared back to the automatic name
    expect(host.list()[0].label).toBeNull();
  });

  it('never lists a terminal DevDeck opened for itself, like a provider login', () => {
    // A deck reconciles against this list, so anything in it becomes a project tile — an OAuth prompt
    // included, against a home-directory path no scanned folder covers.
    const f = fake();
    const host = new PtyHost(() => f.proc);
    host.create('usage-login:claude:1', 'pwsh', [], 'C:\home', 80, 24, () => {}, () => {}, { internal: true });
    host.create('C:\repo#1', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {}, { projectPath: 'C:\repo', agentId: 'claude' });
    expect(host.list().map((s) => s.id)).toEqual(['C:\repo#1']);
    expect(host.pid('usage-login:claude:1')).toBe(1); // still a real session for input/resize/kill
  });

  it('reports whether note() changed anything, so a no-op is not announced to every machine', () => {
    const host = new PtyHost(() => fake().proc);
    host.create('s', 'pwsh', [], 'C:\repo', 80, 24, () => {}, () => {}, { projectPath: 'C:\repo', sessionId: 'c1', agentId: 'claude' });
    expect(host.note('s', { label: 'triage' })).toBe(true);
    expect(host.note('s', { label: 'triage' })).toBe(false);
    expect(host.note('s', { sessionId: 'c1' })).toBe(false);
    expect(host.note('gone', { label: 'triage' })).toBe(false);
  });
});

describe('limits and crash recovery', () => {
  it(`refuses project terminal number ${MAX_SESSIONS + 1} with a readable error — internal ones do not count`, () => {
    const host = new PtyHost(() => fakeProc());
    for (let i = 0; i < MAX_SESSIONS; i++) host.create(`p${i}`, 'pwsh', [], '.', 80, 24, () => {}, () => {});
    expect(() => host.create('one-too-many', 'pwsh', [], '.', 80, 24, () => {}, () => {}))
      .toThrow(`Too many terminals open (${MAX_SESSIONS}). Close some sessions first.`);
    expect(() => host.create('login', 'pwsh', [], '.', 80, 24, () => {}, () => {}, { internal: true })).not.toThrow();
    host.kill('p0');
    expect(() => host.create('room-again', 'pwsh', [], '.', 80, 24, () => {}, () => {})).not.toThrow();
  });

  it("killInternal() reaps only DevDeck's own login shells and leaves project sessions running", () => {
    const login = fakeProc(), project = fakeProc();
    const host = new PtyHost(vi.fn().mockReturnValueOnce(login).mockReturnValueOnce(project));
    host.create('usage-login:claude:1', 'pwsh', [], '.', 80, 24, () => {}, () => {}, { internal: true });
    host.create('C:\repo#1', 'pwsh', [], '.', 80, 24, () => {}, () => {});
    host.killInternal();
    expect(login.kill).toHaveBeenCalledTimes(1);
    expect(project.kill).not.toHaveBeenCalled();
    expect(host.list().map((s) => s.id)).toEqual(['C:\repo#1']);
    expect(host.pid('usage-login:claude:1')).toBeNull();
  });
});

describe('Windows process-tree kill', () => {
  it('runs the tree kill FIRST (while the shell still exists) and the pty kill only after it settles', async () => {
    const order: string[] = [];
    let release!: () => void;
    const inner = fakeProc();
    (inner.kill as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('pty.kill'));
    const wrapped = withTreeKill(inner, (pid) => { order.push(`taskkill ${pid}`); return new Promise<void>((r) => { release = r; }); });
    wrapped.kill();
    wrapped.kill(); // a second close while the first is in flight does not start another
    expect(order).toEqual(['taskkill 1234']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['taskkill 1234', 'pty.kill']);
  });

  it('still closes the pty when the tree kill fails', async () => {
    const inner = fakeProc();
    const wrapped = withTreeKill(inner, () => Promise.reject(new Error('taskkill missing')));
    wrapped.kill();
    await new Promise((r) => setTimeout(r, 0));
    expect(inner.kill).toHaveBeenCalledTimes(1);
  });

  it('forwards everything else to the real pty', () => {
    const inner = fakeProc();
    const wrapped = withTreeKill(inner, async () => {});
    wrapped.write('x'); wrapped.resize(100, 30);
    expect(wrapped.pid).toBe(1234);
    expect(inner.write).toHaveBeenCalledWith('x');
    expect(inner.resize).toHaveBeenCalledWith(100, 30);
  });

  it('shutdown still drains: exit callbacks fire once the deferred pty kill has run', async () => {
    const inner = fakeProc();
    (inner.kill as ReturnType<typeof vi.fn>).mockImplementation(() => inner.emitExit(1));
    const host = new PtyHost(() => withTreeKill(inner, async () => {}));
    const onExit = vi.fn();
    host.create('a', 'pwsh', [], '.', 80, 24, () => {}, onExit);
    await host.shutdown(1_000);
    expect(onExit).toHaveBeenCalledWith({ exitCode: 1 });
  });

  it('taskkillTree spawns `taskkill /PID <pid> /T /F` hidden and resolves when it exits', async () => {
    const child = new EventEmitter();
    const spawnFn = vi.fn(() => child);
    const done = taskkillTree(4321, spawnFn as never, 1_000);
    expect(spawnFn).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.emit('exit', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('taskkillTree gives up after its timeout instead of holding the close forever', async () => {
    vi.useFakeTimers();
    try {
      const done = taskkillTree(4321, (() => new EventEmitter()) as never, 3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(done).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('taskkillTree does nothing for a pid it cannot trust', async () => {
    const spawnFn = vi.fn();
    await taskkillTree(0, spawnFn as never);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('Claude Code status probe (OSC 7501)', () => {
  const PROBE = '\x1b]7501;?\x07';
  const open = (programStatus: boolean, bundledConpty: boolean) => {
    const proc = Object.assign(fakeProc(), { bundledConpty });
    const spawn = vi.fn(() => proc) as unknown as PtySpawn;
    const onData = vi.fn();
    new PtyHost(spawn).create('s', 'pwsh', [], '.', 80, 24, onData, () => {}, { programStatus });
    return { proc, spawn, onData };
  };
  const onWindowsOrElsewhere = process.platform === 'win32';

  it('answers the probe once, even split across chunks, and still passes the output on', () => {
    const { proc, onData } = open(true, true);
    proc.emitData('banner\x1b]75');
    proc.emitData('01;?\x07\x1b[c');
    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith(PROBE);
    expect(onData.mock.calls.map((c) => c[0]).join('')).toContain('\x1b]7501;?');
  });

  it('asks Windows for the bundled ConPTY only when the status is wanted', () => {
    const on = open(true, true), off = open(false, false);
    const opts = (s: PtySpawn) => (s as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts(on.spawn).bundledConpty).toBe(onWindowsOrElsewhere ? true : undefined);
    expect(opts(off.spawn).bundledConpty).toBeUndefined();
  });

  it('never answers when the status was not asked for', () => {
    const { proc } = open(false, false);
    proc.emitData(PROBE);
    expect(proc.write).not.toHaveBeenCalled();
  });

  it('on Windows, does not answer through Windows\' own ConPTY, where the answer would arrive too late', () => {
    const { proc } = open(true, false);
    proc.emitData(PROBE);
    if (onWindowsOrElsewhere) expect(proc.write).not.toHaveBeenCalled();
    else expect(proc.write).toHaveBeenCalledWith(PROBE);
  });
});

it('the tree-kill wrapper keeps saying which ConPTY the terminal runs on', () => {
  // Dropping it here made every session look like it ran on Windows' own ConPTY, so the status
  // probe was never answered (found by qa:cockpit-tools).
  expect(withTreeKill(Object.assign(fakeProc(), { bundledConpty: true }), async () => {}).bundledConpty).toBe(true);
});
