import { describe, expect, it } from 'vitest';
import {
  allSelected, beginSelecting, closeBreakdown, describeBreakdown, emptySelection, endSelecting,
  pruneSelection, rangeTo, selectAll, toggleGroup, toggleKey,
} from './sessionSelection';
import type { ShellSessionInput } from './shellNavigation';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('picking sessions to close at once', () => {
  it('starts empty and out of the mode; the Select button turns the mode on with nothing picked', () => {
    const s = emptySelection();
    expect(s.mode).toBe(false);
    const on = beginSelecting(s);
    expect(on.mode).toBe(true);
    expect(on.keys.size).toBe(0);
  });

  it('a pick turns the mode on and becomes the anchor; picking again un-picks', () => {
    let s = toggleKey(emptySelection(), 'b');
    expect([...s.keys]).toEqual(['b']);
    expect(s.anchor).toBe('b');
    expect(s.mode).toBe(true);
    s = toggleKey(s, 'b');
    expect(s.keys.size).toBe(0);
    expect(s.mode).toBe(true); // the mode outlives an empty selection — Done or Escape ends it
  });

  it('Shift+click ranges from the anchor in rail order, either direction, and keeps the anchor', () => {
    let s = toggleKey(emptySelection(), 'd');
    s = rangeTo(s, order, 'b');
    expect([...s.keys].sort()).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('d');
    s = rangeTo(s, order, 'e'); // re-ranges from the same anchor
    expect([...s.keys].sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('Shift+click with no anchor on screen is a plain pick', () => {
    const s = rangeTo(emptySelection(), order, 'c');
    expect([...s.keys]).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('select all picks every row the rail shows and nothing else', () => {
    const s = selectAll(toggleKey(emptySelection(), 'zzz'), order);
    expect([...s.keys].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'zzz']);
    expect(allSelected(s, order)).toBe(true);
    expect(allSelected(s, [])).toBe(false);
  });

  it('a group checkbox fills a half-picked group, and empties one that is all picked', () => {
    let s = toggleKey(emptySelection(), 'b');
    s = toggleGroup(s, ['a', 'b', 'c']);
    expect([...s.keys].sort()).toEqual(['a', 'b', 'c']);
    s = toggleGroup(s, ['a', 'b', 'c']);
    expect(s.keys.size).toBe(0);
    expect(s.mode).toBe(true);
  });

  it('rows that left the rail leave the selection; the anchor goes with them', () => {
    const s = selectAll(emptySelection(), order);
    const pruned = pruneSelection(s, new Set(['a', 'c']));
    expect([...pruned.keys]).toEqual(['a', 'c']);
    expect(pruned.anchor).toBe(null);
    expect(pruned.mode).toBe(true);
    expect(pruneSelection(pruned, new Set(['a', 'c', 'x']))).toBe(pruned); // nothing to drop → same object
  });

  it('Done drops the picks and leaves the mode', () => {
    const s = endSelecting();
    expect(s.keys.size).toBe(0);
    expect(s.mode).toBe(false);
  });
});

describe('what a close of the picked rows amounts to', () => {
  const items: ShellSessionInput[] = [
    { id: 'l1', projectPath: 'C:\\a', label: 'a', detail: '', activity: 'idle', pinned: false },
    { id: 'l2', projectPath: 'C:\\b', label: 'b', detail: '', activity: 'working', pinned: false, machineId: 'local' },
    { id: 'r1', projectPath: 'D:\\x', label: 'x', detail: '', activity: 'idle', pinned: false, machineId: 'm-4080', machineLabel: 'SIHYEONG-4080' },
    { id: 'r2', projectPath: 'D:\\y', label: 'y', detail: '', activity: 'idle', pinned: false, machineId: 'm-4080', machineLabel: 'SIHYEONG-4080' },
    { id: 'r3', projectPath: 'D:\\z', label: 'z', detail: '', activity: 'idle', pinned: false, machineId: 'm-nb', machineLabel: '' },
    { id: 'bg:local:1', projectPath: 'C:\\c', label: 'c', detail: '', activity: 'turn', pinned: false, backgroundAgent: true },
    { id: 'p1', projectPath: 'C:\\d', label: 'd', detail: '', activity: 'idle', pinned: false, previous: true },
  ];

  it('counts each kind, remote ones per machine, and skips ids no longer listed', () => {
    const b = closeBreakdown(items, ['l1', 'l2', 'r1', 'r2', 'r3', 'bg:local:1', 'p1', 'gone']);
    expect(b.local).toBe(2);
    expect([...b.remote]).toEqual([['SIHYEONG-4080', 2], ['m-nb', 1]]); // a machine without a label is named by its id
    expect(b.background).toBe(1);
    expect(b.previous).toBe(1);
  });

  it('describes only the kinds that are present, in rail order', () => {
    const words = {
      local: (n: number) => `${n} here`, remote: (n: number, m: string) => `${n} on ${m}`,
      background: (n: number) => `${n} background`, previous: (n: number) => `${n} saved`,
    };
    expect(describeBreakdown(closeBreakdown(items, ['p1', 'r1', 'l1']), words)).toEqual(['1 here', '1 on SIHYEONG-4080', '1 saved']);
    expect(describeBreakdown(closeBreakdown(items, ['gone']), words)).toEqual([]);
  });
});
