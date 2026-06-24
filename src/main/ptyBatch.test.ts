import { describe, it, expect } from 'vitest';
import { PtyBatcher } from './ptyBatch';

function harness(maxBytes?: number) {
  const emits: { id: string; chunk: string }[] = [];
  let scheduled: (() => void) | null = null;
  let scheduleCount = 0;
  const b = new PtyBatcher(
    (id, chunk) => emits.push({ id, chunk }),
    (cb) => { scheduled = cb; scheduleCount++; },
    maxBytes,
  );
  return { b, emits, fire: () => { const c = scheduled; scheduled = null; c?.(); }, scheduleCount: () => scheduleCount };
}

describe('PtyBatcher', () => {
  it('coalesces consecutive chunks for one id into a single emit on flush', () => {
    const h = harness();
    h.b.push('a', 'foo');
    h.b.push('a', 'bar');
    expect(h.emits).toEqual([]);                       // nothing emitted until the flush fires
    h.fire();
    expect(h.emits).toEqual([{ id: 'a', chunk: 'foobar' }]);
  });

  it('keeps separate sessions separate', () => {
    const h = harness();
    h.b.push('a', 'x'); h.b.push('b', 'y');
    h.fire();
    expect(h.emits).toEqual([{ id: 'a', chunk: 'x' }, { id: 'b', chunk: 'y' }]);
  });

  it('schedules a flush only once until it fires', () => {
    const h = harness();
    h.b.push('a', '1'); h.b.push('a', '2'); h.b.push('b', '3');
    expect(h.scheduleCount()).toBe(1);                 // one timer for the whole burst
    h.fire();
    h.b.push('a', '4');                                // a fresh burst schedules again
    expect(h.scheduleCount()).toBe(2);
  });

  it('flushes immediately (no timer wait) when a buffer exceeds the byte cap', () => {
    const h = harness(4);
    h.b.push('a', 'abcde');                            // 5 bytes > cap 4 → flush now
    expect(h.emits).toEqual([{ id: 'a', chunk: 'abcde' }]);
  });

  it('drop() discards a pending buffer', () => {
    const h = harness();
    h.b.push('a', 'gone'); h.b.push('b', 'keep');
    h.b.drop('a');
    h.fire();
    expect(h.emits).toEqual([{ id: 'b', chunk: 'keep' }]);
  });

  it('isolates a throwing emit: siblings still flush, the buffer clears, and flush never throws', () => {
    const emitted: { id: string; chunk: string }[] = [];
    let scheduled: (() => void) | null = null;
    const b = new PtyBatcher(
      (id, chunk) => { if (id === 'bad') throw new Error('webContents gone'); emitted.push({ id, chunk }); },
      (cb) => { scheduled = cb; },
    );
    b.push('good1', 'a'); b.push('bad', 'b'); b.push('good2', 'c');
    // A destroyed/reloading webContents throwing from emit must NOT escape the timer callback —
    // an unhandled throw there takes down Electron's whole main process, killing every terminal.
    expect(() => scheduled!()).not.toThrow();
    expect(emitted).toEqual([{ id: 'good1', chunk: 'a' }, { id: 'good2', chunk: 'c' }]); // bad's throw didn't skip good2
    // The buffer was cleared despite the throw — the next flush must not re-emit the survivors.
    b.push('good1', 'd');
    scheduled!();
    expect(emitted).toEqual([{ id: 'good1', chunk: 'a' }, { id: 'good2', chunk: 'c' }, { id: 'good1', chunk: 'd' }]);
  });
});
