import { describe, it, expect } from 'vitest';
import { codexCwd, codexFirstUserMessage, codexLastUserMessage } from './codexParse';

const meta = (cwd: string, id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789') =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-06-06T00:00:00Z' } });
const user = (message: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });
const agent = (message: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } });

describe('codexCwd', () => {
  it('reads cwd from the session_meta header', () => {
    expect(codexCwd([meta('C:\\Users\\dev\\app'), user('hi')].join('\n'))).toBe('C:\\Users\\dev\\app');
  });
  it('returns null when there is no session_meta', () => {
    expect(codexCwd(user('hi'))).toBeNull();
    expect(codexCwd('')).toBeNull();
  });
});

describe('codexFirstUserMessage / codexLastUserMessage', () => {
  const jsonl = [meta('C:\\g\\a'), user('first thing'), agent('working'), user('the last thing')].join('\n');
  it('first returns the earliest user_message text', () => {
    expect(codexFirstUserMessage(jsonl)).toBe('first thing');
  });
  it('last returns the latest user_message text', () => {
    expect(codexLastUserMessage(jsonl)).toBe('the last thing');
  });
  it('ignore agent_message + tolerate bad lines; null when no user_message', () => {
    expect(codexLastUserMessage([meta('C:\\g\\a'), agent('only agent'), '{bad'].join('\n'))).toBeNull();
    expect(codexFirstUserMessage('')).toBeNull();
  });
});
