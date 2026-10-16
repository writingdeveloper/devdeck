import { describe, expect, it } from 'vitest';
import { CloseTombstones } from './closeTombstones';

describe('CloseTombstones', () => {
  it('suppresses a closed id through the stale announcements that still list it', () => {
    const t = new CloseTombstones();
    for (const id of ['A', 'B', 'C']) t.add('local', id);
    // The first announcement after closing A still lists B and C: none of them may be adopted.
    t.observe('local', ['B', 'C', 'D']);
    expect(['A', 'B', 'C'].map((id) => t.has('local', id))).toEqual([false, true, true]);
    t.observe('local', ['C', 'D']);
    t.observe('local', ['D']);
    expect(['B', 'C'].some((id) => t.has('local', id))).toBe(false);
  });

  it('keeps an undelivered close through announcements until it is settled', () => {
    const t = new CloseTombstones();
    t.add('m1', 'link:m1:x', true);
    t.observe('m1', []);
    expect(t.has('m1', 'link:m1:x')).toBe(true);
    expect(t.pending('m1')).toEqual(['link:m1:x']);
    t.settle('m1', 'link:m1:x');
    expect(t.pending('m1')).toEqual([]);
    t.observe('m1', ['link:m1:x']); // still running a moment after the close was delivered
    expect(t.has('m1', 'link:m1:x')).toBe(true);
    t.observe('m1', []);
    expect(t.has('m1', 'link:m1:x')).toBe(false);
  });

  it('is per machine: one machine listing nothing releases nothing of another', () => {
    const t = new CloseTombstones();
    t.add('local', 'p#1');
    t.add('m1', 'link:m1:p#1');
    t.observe('m1', []);
    expect(t.has('local', 'p#1')).toBe(true);
    expect(t.has('m1', 'link:m1:p#1')).toBe(false);
  });

  it('lists every owed close across machines', () => {
    const t = new CloseTombstones();
    t.add('m1', 'a', true); t.add('m2', 'b', true); t.add('m2', 'c');
    expect(t.allPending()).toEqual([{ machineId: 'm1', id: 'a' }, { machineId: 'm2', id: 'b' }]);
  });

  it('forgets a refused close so the session can be shown again', () => {
    const t = new CloseTombstones();
    t.add('m1', 'x', true);
    t.remove('m1', 'x');
    expect(t.has('m1', 'x')).toBe(false);
    expect(t.pending('m1')).toEqual([]);
  });
});
