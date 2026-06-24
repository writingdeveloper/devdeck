import { describe, it, expect } from 'vitest';
import { sanitizePersistedList } from './cockpitPersist';

describe('sanitizePersistedList', () => {
  it('returns [] for non-arrays', () => {
    expect(sanitizePersistedList(null)).toEqual([]);
    expect(sanitizePersistedList({})).toEqual([]);
    expect(sanitizePersistedList('x')).toEqual([]);
  });

  it('keeps valid entries verbatim (label defaults to null)', () => {
    const r = sanitizePersistedList([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity' }]);
    expect(r).toEqual([{ projectPath: 'C:/a/b', name: 'b', sessionId: 's1', agentId: 'antigravity', label: null }]);
  });

  it('keeps, trims, and caps a custom label; coerces empty/non-string to null', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: '  auth refactor  ' }])[0].label).toBe('auth refactor');
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: 'x'.repeat(80) }])[0].label).toHaveLength(60);
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: '   ' }])[0].label).toBeNull();
    expect(sanitizePersistedList([{ projectPath: 'C:/a', label: 42 }])[0].label).toBeNull();
  });

  it('drops entries without a string projectPath', () => {
    const r = sanitizePersistedList([{ name: 'x' }, { projectPath: '' }, { projectPath: 42 }, { projectPath: 'C:/ok' }]);
    expect(r.map((e) => e.projectPath)).toEqual(['C:/ok']);
  });

  it('defaults name to the path basename', () => {
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck' }])[0].name).toBe('devdeck');
    expect(sanitizePersistedList([{ projectPath: 'C:/Users/me/devdeck/' }])[0].name).toBe('devdeck');
  });

  it('coerces sessionId to string|null and agentId to claude/antigravity', () => {
    const r = sanitizePersistedList([
      { projectPath: 'C:/a', sessionId: 123 },
      { projectPath: 'C:/b', sessionId: 'sid', agentId: 'antigravity' },
      { projectPath: 'C:/c', agentId: 'weird' },
    ]);
    expect(r[0]).toMatchObject({ sessionId: null, agentId: 'claude' });
    expect(r[1]).toMatchObject({ sessionId: 'sid', agentId: 'antigravity' });
    expect(r[2]).toMatchObject({ agentId: 'claude' });
  });

  it('caps at 50 entries', () => {
    const big = Array.from({ length: 80 }, (_v, i) => ({ projectPath: `C:/p${i}` }));
    expect(sanitizePersistedList(big).length).toBe(50);
  });
});
