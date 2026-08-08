import { describe, expect, it, vi } from 'vitest';
import { createAgentSelectionStore } from './agentSelection';

describe('createAgentSelectionStore', () => {
  it('notifies once when the selected installed provider changes', () => {
    const store = createAgentSelectionStore(['claude', 'codex'], 'claude');
    const changed = vi.fn();
    store.subscribe(changed);
    store.select('codex');
    store.select('codex');
    expect(store.selected()).toBe('codex');
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith('codex');
  });

  it('ignores providers outside the initialized installed set', () => {
    const store = createAgentSelectionStore(['claude'], 'claude');
    store.select('codex');
    expect(store.selected()).toBe('claude');
  });
});
