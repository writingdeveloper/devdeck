import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { closeElectron } from './electron-lifecycle.mjs';

afterEach(() => vi.useRealTimers());

it('fails and terminates the harness process when shutdown never answers', async () => {
  vi.useFakeTimers();
  const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
  const app = { process: () => proc, evaluate: () => new Promise(() => {}), close: vi.fn() };
  const work = closeElectron(app);
  const checked = expect(work).rejects.toThrow('did not exit within 30 seconds');
  expect(closeElectron(app)).toBe(work);
  await vi.advanceTimersByTimeAsync(30_000);
  await checked;
  expect(proc.kill).toHaveBeenCalledOnce();
});

it('rejects an abnormal exit even when the app close call succeeds', async () => {
  const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
  const app = { process: () => proc, evaluate: async () => {}, close: async () => proc.emit('exit', 7, null) };
  await expect(closeElectron(app)).rejects.toThrow('Electron exited abnormally: 7');
  expect(proc.kill).not.toHaveBeenCalled();
});
