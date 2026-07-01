import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installGlobalErrorHandlers, installAppCrashHandlers } from './errorGuard';

describe('installGlobalErrorHandlers', () => {
  it('forwards an uncaughtException to onError instead of letting it terminate the process', () => {
    const seen: { kind: string; err: unknown }[] = [];
    const proc = new EventEmitter();
    installGlobalErrorHandlers((kind, err) => seen.push({ kind, err }), proc);
    const boom = new Error('boom');
    proc.emit('uncaughtException', boom);
    expect(seen).toEqual([{ kind: 'uncaughtException', err: boom }]);
  });

  it('forwards an unhandledRejection to onError', () => {
    const seen: { kind: string; err: unknown }[] = [];
    const proc = new EventEmitter();
    installGlobalErrorHandlers((kind, err) => seen.push({ kind, err }), proc);
    const reason = new Error('nope');
    proc.emit('unhandledRejection', reason);
    expect(seen).toEqual([{ kind: 'unhandledRejection', err: reason }]);
  });

  it('keeps running when onError itself throws — a failing logger must not re-crash the trap', () => {
    const proc = new EventEmitter();
    installGlobalErrorHandlers(() => { throw new Error('logger broke'); }, proc);
    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow();
  });
});

describe('installAppCrashHandlers', () => {
  // render-process-gone / child-process-gone are Electron `app` events (not `process` events) that
  // installGlobalErrorHandlers cannot see — they cover renderer/GPU/utility-process crashes, which
  // previously left zero trace anywhere (no devdeck-errors.log entry, no Windows crash event).
  it('reports an abnormal render-process-gone (crashed/killed/oom) with reason + exitCode', () => {
    const seen: unknown[] = [];
    const appLike = new EventEmitter();
    installAppCrashHandlers(appLike, (kind, detail) => seen.push({ kind, detail }));
    appLike.emit('render-process-gone', {}, { id: 1 }, { reason: 'crashed', exitCode: 11 });
    expect(seen).toEqual([{ kind: 'render-process-gone', detail: { reason: 'crashed', exitCode: 11 } }]);
  });

  it('does NOT report a clean-exit render-process-gone — that is a normal window close/reload, not a crash', () => {
    const seen: unknown[] = [];
    const appLike = new EventEmitter();
    installAppCrashHandlers(appLike, (kind, detail) => seen.push({ kind, detail }));
    appLike.emit('render-process-gone', {}, { id: 1 }, { reason: 'clean-exit', exitCode: 0 });
    expect(seen).toEqual([]);
  });

  it('reports an abnormal child-process-gone (e.g. GPU crash) with its process type', () => {
    const seen: unknown[] = [];
    const appLike = new EventEmitter();
    installAppCrashHandlers(appLike, (kind, detail) => seen.push({ kind, detail }));
    appLike.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
    expect(seen).toEqual([{ kind: 'child-process-gone', detail: { type: 'GPU', reason: 'crashed', exitCode: 139 } }]);
  });

  it('does not report a clean-exit child-process-gone', () => {
    const seen: unknown[] = [];
    const appLike = new EventEmitter();
    installAppCrashHandlers(appLike, (kind, detail) => seen.push({ kind, detail }));
    appLike.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
    expect(seen).toEqual([]);
  });

  it('keeps running when onEvent itself throws', () => {
    const appLike = new EventEmitter();
    installAppCrashHandlers(appLike, () => { throw new Error('logger broke'); });
    expect(() => appLike.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 1 })).not.toThrow();
  });
});
