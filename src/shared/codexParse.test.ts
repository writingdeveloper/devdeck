import { describe, expect, it } from 'vitest';
import { codexFirstUserMessage, codexLastUserMessage, codexSessionMeta } from './codexParse';

const ID = '019f91b2-fa6d-7971-b19d-c07092dcfc57';

describe('codexSessionMeta', () => {
  it('reads the id and cwd from a session_meta payload only', () => {
    const header = JSON.stringify({
      type: 'session_meta',
      payload: { id: ID, cwd: 'C:\\repo' },
      id: 'wrong-id',
      cwd: 'wrong-cwd',
    });

    expect(codexSessionMeta(header)).toEqual({ id: ID, cwd: 'C:\\repo' });
  });

  it('returns null for malformed JSON and incomplete metadata', () => {
    expect(codexSessionMeta('{')).toBeNull();
    expect(codexSessionMeta(JSON.stringify({ type: 'session_meta', payload: { id: ID } }))).toBeNull();
  });
});

describe('Codex user messages', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '  first  ' } }),
    'not json',
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'ignore' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '   ' }, { type: 'input_text', text: '  latest  ' }, { type: 'input_text', text: 'ignored second item' }] } }),
  ].join('\n');

  it('returns the trimmed first legacy user message', () => {
    expect(codexFirstUserMessage(lines)).toBe('first');
  });

  it('returns the trimmed last current user message', () => {
    expect(codexLastUserMessage(lines)).toBe('latest');
  });

  it('returns null when every recognized user message is blank or input is malformed', () => {
    const blank = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '  ' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] } }),
      '{',
    ].join('\n');

    expect(codexFirstUserMessage(blank)).toBeNull();
    expect(codexLastUserMessage(blank)).toBeNull();
  });
});
