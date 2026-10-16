import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { getProvider, availableAgents, resolveProjectOpenCommand, agentAvailableAtHome, resolveOpenSession } from './agents';

describe('agent providers', () => {
  it('claude buildCommand maps kinds correctly', () => {
    const c = getProvider('claude');
    expect(c.buildCommand('new')).toBe('claude');
    expect(c.buildCommand('new', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('claude --session-id a0b1c2d3-e4f5-6789-abcd-ef0123456789');
    expect(c.buildCommand('continue')).toBe('claude -c');
    expect(c.buildCommand('resume', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('claude --resume a0b1c2d3-e4f5-6789-abcd-ef0123456789');
  });
  it('antigravity buildCommand maps kinds correctly', () => {
    const x = getProvider('antigravity');
    expect(x.buildCommand('new')).toBe('agy');
    expect(x.buildCommand('continue')).toBe('agy -c');
    expect(x.buildCommand('resume', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('agy --conversation a0b1c2d3-e4f5-6789-abcd-ef0123456789');
  });
  it('codex buildCommand maps kinds correctly', () => {
    const c = getProvider('codex');
    expect(c.buildCommand('new')).toBe('codex');
    expect(c.buildCommand('continue')).toBe('codex resume --last');
    expect(c.buildCommand('resume', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe('codex resume a0b1c2d3-e4f5-6789-abcd-ef0123456789');
  });
  it('resume with an invalid id falls back to continue (no injection)', () => {
    expect(getProvider('claude').buildCommand('resume', '$(evil)')).toBe('claude -c');
    expect(getProvider('antigravity').buildCommand('resume', '$(evil)')).toBe('agy -c');
    expect(getProvider('codex').buildCommand('resume', '$(evil)')).toBe('codex resume --last');
  });
  it('availableAgents filters by isAvailable', () => {
    expect(availableAgents(() => false)).toEqual([]);
    expect(availableAgents(() => true).sort()).toEqual(['antigravity', 'claude', 'codex']);
  });

  it('recognizes a fresh login root before the first session creates a projects/sessions folder', () => {
    const home = join(process.cwd(), 'fresh-home');
    expect(agentAvailableAtHome('codex', home, (path) => path === join(home, '.codex'))).toBe(true);
    expect(agentAvailableAtHome('claude', home, (path) => path === join(home, '.claude'))).toBe(true);
    expect(agentAvailableAtHome('codex', home, () => false)).toBe(false);
  });

  it('resolves an external launch only inside the explicitly requested provider', () => {
    const codex = getProvider('codex');
    expect(resolveProjectOpenCommand(codex, { mode: 'auto', sessionId: null, hasHistory: true }))
      .toBe('codex resume --last');
    expect(resolveProjectOpenCommand(codex, { mode: 'new', sessionId: null, hasHistory: true }))
      .toBe('codex');
    expect(resolveProjectOpenCommand(getProvider('claude'), { mode: 'auto', sessionId: 'abc12345', hasHistory: true }))
      .toBe('claude --resume abc12345');
  });
});

describe('resolveOpenSession with an id the provider refuses', () => {
  // `buildCommand('resume', bad)` falls back to `claude -c`, which opens the latest conversation —
  // reporting the bad id would save the tile against a conversation nothing opened.
  const gen = () => '00000000-0000-4000-8000-000000000000';
  it('reports no session id when the resume id fails validation', () => {
    for (const id of ['../../etc/passwd', 'not an id; rm -rf', '']) {
      const r = resolveOpenSession(getProvider('claude'), { fresh: false, sessionId: id, sessionCount: 3, latestId: 'abc12345', genId: gen });
      expect(r).toEqual({ command: 'claude -c', sessionId: null });
    }
  });
  it('keeps a valid resume id', () => {
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    expect(resolveOpenSession(getProvider('codex'), { fresh: false, sessionId: id, sessionCount: 1, latestId: null, genId: gen }))
      .toEqual({ command: `codex resume ${id}`, sessionId: id });
  });
});
