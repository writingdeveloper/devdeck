import { describe, it, expect } from 'vitest';
import { getProvider, availableAgents } from './agents';

describe('agent providers', () => {
  it('claude buildCommand maps kinds correctly', () => {
    const c = getProvider('claude');
    expect(c.buildCommand('new')).toBe('claude');
    expect(c.buildCommand('new', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('claude --session-id a0b1c2d3-e4f5-6789-abcd-ef0123456789');
    expect(c.buildCommand('continue')).toBe('claude -c');
    expect(c.buildCommand('resume', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('claude --resume a0b1c2d3-e4f5-6789-abcd-ef0123456789');
  });
  it('codex buildCommand maps kinds correctly', () => {
    const x = getProvider('codex');
    expect(x.buildCommand('new')).toBe('codex');
    expect(x.buildCommand('continue')).toBe('codex resume --last');
    expect(x.buildCommand('resume', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('codex resume a0b1c2d3-e4f5-6789-abcd-ef0123456789');
  });
  it('resume with an invalid id falls back to continue (no injection)', () => {
    expect(getProvider('claude').buildCommand('resume', '$(evil)')).toBe('claude -c');
    expect(getProvider('codex').buildCommand('resume', '$(evil)')).toBe('codex resume --last');
  });
  it('availableAgents filters by isAvailable', () => {
    expect(availableAgents(() => false)).toEqual([]);
    expect(availableAgents(() => true).sort()).toEqual(['claude', 'codex']);
  });
});
