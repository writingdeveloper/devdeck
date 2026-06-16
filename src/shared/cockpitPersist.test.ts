import { describe, it, expect } from 'vitest';
import { sanitizePersistedList } from './cockpitPersist';

describe('sanitizePersistedList', () => {
  it('returns [] for non-arrays', () => {
    expect(sanitizePersistedList(null)).toEqual([]);
    expect(sanitizePersistedList({})).toEqual([]);
    expect(sanitizePersistedList('x')).toEqual([]);
  });

  it('keeps valid entries verbatim', () => {
    const r = sanitizePersistedList([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'codex' }]);
    expect(r).toEqual([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'codex' }]);
  });

  it('drops entries without a string projectPath', () => {
    const r = sanitizePersistedList([{ name: 'x' }, { projectPath: '' }, { projectPath: 42 }, { projectPath: 'C:/ok' }]);
    expect(r.map((e) => e.projectPath)).toEqual(['C:/ok']);
  });

  it('defaults name to the path basename', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck' }])[0].name).toBe('devdeck');
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck/' }])[0].name).toBe('devdeck');
  });

  it('coerces sessionId to string|null and agentId to claude/codex', () => {
    const r = sanitizePersistedList([
      { projectPath: 'C:/a', sessionId: 123 },
      { projectPath: 'C:/b', sessionId: 'sid', agentId: 'codex' },
      { projectPath: 'C:/c', agentId: 'weird' },
    ]);
    expect(r[0]).toMatchObject({ sessionId: null, agentId: 'claude' });
    expect(r[1]).toMatchObject({ sessionId: 'sid', agentId: 'codex' });
    expect(r[2]).toMatchObject({ agentId: 'claude' });
  });

  it('caps at 50 entries', () => {
    const big = Array.from({ length: 80 }, (_v, i) => ({ projectPath: `C:/p${i}` }));
    expect(sanitizePersistedList(big).length).toBe(50);
  });
});
