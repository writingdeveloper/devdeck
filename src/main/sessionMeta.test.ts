import { describe, it, expect } from 'vitest';
import { readClaudeSessionMeta } from './sessionMeta';

describe('readClaudeSessionMeta', () => {
  it('rejects a traversal sessionId — no path escape (returns {null,0})', () => {
    expect(readClaudeSessionMeta('C:/a/b', '../../../../etc/passwd', '/tmp/claude')).toEqual({ model: null, activeMs: 0 });
    expect(readClaudeSessionMeta('C:/a/b', 'a/../../b', '/tmp/claude')).toEqual({ model: null, activeMs: 0 });
  });
  it('returns {null,0} for a valid id whose file is missing', () => {
    expect(readClaudeSessionMeta('C:/a/b', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', '/no/such/dir')).toEqual({ model: null, activeMs: 0 });
  });
});
