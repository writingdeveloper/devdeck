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
    const deck = await import('./machineDeck.js');
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
    const deck = await import('./machineDeck.js');
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
    const deck = await import('./machineDeck.js');
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

describe('a paired PC on an older DevDeck', () => {
  const olderHost = () => {
    const missing = (name: string) => vi.fn().mockRejectedValue(new Error(`no such method: ${name}`));
    vi.stubGlobal('window', { devdeck: { machine: () => ({ cockpit: {
      sessionTurns: missing('cockpit:sessionTurns'),
      receiveFile: missing('cockpit:receiveFile'),
      sessionImages: missing('cockpit:sessionImages'),
    } }) } });
  };

  it('says the timeline needs that PC updated, rather than showing an empty one', async () => {
    olderHost();
    const deck = await import('./machineDeck.js');
    await expect(deck.deckFor('remote').cockpit.sessionTurns('/p', 's', 'claude')).rejects.toThrow(deck.HOST_TOO_OLD);
  });

  it('passes a missing receiveFile on, so the sender can say why a document did not go', async () => {
    olderHost();
    const deck = await import('./machineDeck.js');
    await expect(deck.deckFor('remote').cockpit.receiveFile('a.log', 'eA==')).rejects.toThrow(/no such method/);
  });

  it('keeps an older host\'s missing image methods quiet, as before', async () => {
    olderHost();
    const deck = await import('./machineDeck.js');
    await expect(deck.deckFor('remote').cockpit.sessionImages('/p', 's', 'claude')).resolves.toEqual([]);
  });
});
