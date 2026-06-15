import { describe, it, expect } from 'vitest';
import { getProvider, resolveOpenCommand } from './agents';

describe('resolveOpenCommand', () => {
  const claude = getProvider('claude');
  it('uses resume when a sessionId is given', () => {
    expect(resolveOpenCommand(claude, 'abc12345', () => 1)).toBe('claude -r abc12345');
  });
  it('uses continue when prior sessions exist', () => {
    expect(resolveOpenCommand(claude, null, () => 3)).toBe('claude -c');
  });
  it('uses new when there are no prior sessions', () => {
    expect(resolveOpenCommand(claude, null, () => 0)).toBe('claude');
  });
});
