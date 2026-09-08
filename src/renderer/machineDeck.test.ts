import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const remote = { machineId: 'remote', machineName: 'Remote', state: 'offline' };
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('machine selection lifecycle', () => {
  it('invalidates an earlier visit even after A → B → A', async () => {
    const deck = await import('./machineDeck');
    const initial = deck.machineSelectionVersion();
    const listener = vi.fn();
    const unsubscribe = deck.onMachineSelected(listener);
    deck.selectMachine('remote');
    deck.selectMachine(deck.LOCAL_MACHINE_ID);
    expect(deck.machineSelectionVersion()).toBe(initial + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    deck.selectMachine('remote');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores an old machine-list response that arrives after a newer one', async () => {
    const old = deferred<unknown[]>();
    const machines = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce([remote]);
    vi.stubGlobal('window', { devdeck: { link: { machines } } });
    const deck = await import('./machineDeck');
    const first = deck.refreshMachines();
    await deck.refreshMachines();
    deck.selectMachine('remote');
    old.resolve([]);
    await first;
    expect(deck.selectedMachineId()).toBe('remote');
    expect(deck.knownMachines()).toEqual([remote]);
  });

  it('preserves selection on read failure and emits selection change when the host is actually forgotten', async () => {
    const machines = vi.fn().mockResolvedValueOnce([remote]).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    vi.stubGlobal('window', { devdeck: { link: { machines } } });
    const deck = await import('./machineDeck');
    await deck.refreshMachines();
    deck.selectMachine('remote');
    const listener = vi.fn();
    deck.onMachineSelected(listener);
    await deck.refreshMachines();
    expect(deck.selectedMachineId()).toBe('remote');
    expect(listener).not.toHaveBeenCalled();
    await deck.refreshMachines();
    expect(deck.selectedMachineId()).toBe(deck.LOCAL_MACHINE_ID);
    expect(listener).toHaveBeenCalledOnce();
  });
});
