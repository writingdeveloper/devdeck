import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installGlobalErrorHandlers } from './errorGuard';

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
