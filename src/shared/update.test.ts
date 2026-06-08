import { describe, it, expect, vi } from 'vitest';
import { wireUpdater, type UpdaterLike, type UpdatePayload } from './update';

/** Fake autoUpdater: records listeners so tests can emit events. */
function fakeUpdater(over: Partial<UpdaterLike> = {}) {
  const listeners: Record<string, (...a: unknown[]) => void> = {};
  const u: UpdaterLike = {
    autoDownload: true,
    on(event, listener) { listeners[event] = listener as (...a: unknown[]) => void; return u; },
    checkForUpdates: vi.fn(() => Promise.resolve()),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
    ...over,
  };
  return { u, emit: (e: string, ...a: unknown[]) => listeners[e]?.(...a) };
}

describe('wireUpdater', () => {
  it('disables autoDownload', () => {
    const { u } = fakeUpdater();
    wireUpdater(u, () => {}, () => {});
    expect(u.autoDownload).toBe(false);
  });

  it('maps updater events to renderer payloads', () => {
    const sent: UpdatePayload[] = [];
    const { u, emit } = fakeUpdater();
    wireUpdater(u, (p) => sent.push(p), () => {});
    emit('update-available', { version: '1.2.3' });
    emit('download-progress', { percent: 42.7 });
    emit('update-downloaded', { version: '1.2.3' });
    expect(sent).toEqual([
      { status: 'available', version: '1.2.3' },
      { status: 'downloading', percent: 43 },
      { status: 'downloaded', version: '1.2.3' },
    ]);
  });

  it('clamps and rounds percent, and tolerates missing fields', () => {
    const sent: UpdatePayload[] = [];
    const { u, emit } = fakeUpdater();
    wireUpdater(u, (p) => sent.push(p), () => {});
    emit('download-progress', { percent: 150 });
    emit('download-progress', {});
    emit('update-available', {});
    expect(sent).toEqual([
      { status: 'downloading', percent: 100 },
      { status: 'downloading', percent: 0 },
      { status: 'available', version: '' },
    ]);
  });

  it('routes the error event to both log and an error payload', () => {
    const sent: UpdatePayload[] = [];
    const log = vi.fn();
    const { u, emit } = fakeUpdater();
    wireUpdater(u, (p) => sent.push(p), log);
    const err = new Error('boom');
    emit('error', err);
    expect(log).toHaveBeenCalledWith(err);
    expect(sent).toEqual([{ status: 'error' }]);
  });

  it('swallows a rejected checkForUpdates/downloadUpdate via log', async () => {
    const log = vi.fn();
    const { u } = fakeUpdater({
      checkForUpdates: vi.fn(() => Promise.reject(new Error('net'))),
      downloadUpdate: vi.fn(() => Promise.reject(new Error('net'))),
    });
    const api = wireUpdater(u, () => {}, log);
    expect(() => api.check()).not.toThrow();
    expect(() => api.download()).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('install calls quitAndInstall', () => {
    const { u } = fakeUpdater();
    const api = wireUpdater(u, () => {}, () => {});
    api.install();
    expect(u.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('maps update-not-available to a none payload', () => {
    const sent: UpdatePayload[] = [];
    const { u, emit } = fakeUpdater();
    wireUpdater(u, (p) => sent.push(p), () => {});
    emit('update-not-available', { version: '1.2.3' });
    expect(sent).toEqual([{ status: 'none' }]);
  });
});
