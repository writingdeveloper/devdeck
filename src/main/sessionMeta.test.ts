import { describe, it, expect } from 'vitest';
import { readClaudeSessionMeta, emptySessionMeta } from './sessionMeta';

describe('readClaudeSessionMeta', () => {
  it('rejects a traversal sessionId — no path escape (returns an empty meta)', () => {
    expect(readClaudeSessionMeta('C:/a/b', '../../../../etc/passwd', '/tmp/claude')).toEqual(emptySessionMeta());
    expect(readClaudeSessionMeta('C:/a/b', 'a/../../b', '/tmp/claude')).toEqual(emptySessionMeta());
  });
  it('returns an empty meta for a valid id whose file is missing', () => {
    expect(readClaudeSessionMeta('C:/a/b', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', '/no/such/dir')).toEqual(emptySessionMeta());
  });
  it('the empty meta is well-formed (callers destructure it without guards)', () => {
    expect(emptySessionMeta()).toEqual({ model: null, activeMs: 0, contextTokens: 0, assistantText: null, editedFiles: [], userText: null, mtimeMs: 0 });
  });
});
