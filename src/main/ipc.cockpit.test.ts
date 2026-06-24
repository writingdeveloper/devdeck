import { describe, it, expect } from 'vitest';
import { getProvider, resolveOpenSession } from './agents';

describe('resolveOpenSession', () => {
  const claude = getProvider('claude');
  const antigravity = getProvider('antigravity');
  const UUID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789'; // hex — passes SESSION_ID_RE, like a real randomUUID()
  const gen = () => UUID;

  it('fresh => claude --session-id <uuid> and pins that id', () => {
    expect(resolveOpenSession(claude, { fresh: true, sessionId: null, sessionCount: 2, latestId: 'old', genId: gen }))
      .toEqual({ command: `claude --session-id ${UUID}`, sessionId: UUID });
  });
  it('resume a specific id', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: 'abc12345', sessionCount: 1, latestId: 'abc12345', genId: gen }))
      .toEqual({ command: 'claude --resume abc12345', sessionId: 'abc12345' });
  });
  it('continue pins the latest id', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: null, sessionCount: 3, latestId: 'latest9', genId: gen }))
      .toEqual({ command: 'claude -c', sessionId: 'latest9' });
  });
  it('new (no sessions) => claude --session-id <uuid>', () => {
    expect(resolveOpenSession(claude, { fresh: false, sessionId: null, sessionCount: 0, latestId: null, genId: gen }))
      .toEqual({ command: `claude --session-id ${UUID}`, sessionId: UUID });
  });
  it('antigravity fresh: no --session-id support => plain new, id not pinned', () => {
    expect(resolveOpenSession(antigravity, { fresh: true, sessionId: null, sessionCount: 0, latestId: null, genId: gen }))
      .toEqual({ command: 'agy', sessionId: null });
  });
});
