import { describe, expect, it } from 'vitest';
import { providerOpenOptions, providerOpenOutcome } from './providerOpen';

describe('providerOpenOutcome', () => {
  it('never treats another provider live in the same project as focusable', () => {
    expect(providerOpenOutcome('codex', ['claude'], ['claude'])).toBe('new');
  });

  it('focuses the requested live provider before considering history', () => {
    expect(providerOpenOutcome('codex', ['codex'], ['codex'])).toBe('focus');
  });

  it('continues requested-provider history when no matching live tile exists', () => {
    expect(providerOpenOutcome('codex', ['claude', 'codex'], ['claude'])).toBe('continue');
  });
});

describe('providerOpenOptions', () => {
  it('puts the selected installed provider first and reports each independent outcome', () => {
    expect(providerOpenOptions(['claude', 'codex', 'antigravity'], 'codex', ['claude'], ['claude']))
      .toEqual([
        { agentId: 'codex', selected: true, outcome: 'new' },
        { agentId: 'claude', selected: false, outcome: 'focus' },
        { agentId: 'antigravity', selected: false, outcome: 'new' },
      ]);
  });
});
