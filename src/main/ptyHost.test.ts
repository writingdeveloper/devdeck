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
