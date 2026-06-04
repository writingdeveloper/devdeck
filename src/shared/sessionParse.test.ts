import { describe, it, expect } from 'vitest';
import { firstUserMessage, lastUserMessage } from './sessionParse';

const line = (o: unknown) => JSON.stringify(o);

describe('firstUserMessage', () => {
  it('returns the first genuine user message text, skipping metadata lines', () => {
    const jsonl = [
      line({ type: 'last-prompt' }),
      line({ type: 'mode' }),
      line({ type: 'user', message: { content: '어제 하던 작업을 이어서' } }),
      line({ type: 'assistant', message: { content: 'ok' } }),
    ].join('\n');
    expect(firstUserMessage(jsonl)).toBe('어제 하던 작업을 이어서');
  });

  it('extracts text from array content blocks', () => {
    const jsonl = line({ type: 'user', message: { content: [{ type: 'text', text: 'hello there' }] } });
    expect(firstUserMessage(jsonl)).toBe('hello there');
  });

  it('skips slash-command, caveat, skill-load, and system-reminder wrappers', () => {
    const jsonl = [
      line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', message: { content: 'Caveat: The messages below were generated…' } }),
      line({ type: 'user', message: { content: 'Base directory for this skill: C:\\x' } }),
      line({ type: 'user', message: { content: '<system-reminder>hi</system-reminder>' } }),
      line({ type: 'user', message: { content: 'the real thing' } }),
    ].join('\n');
    expect(firstUserMessage(jsonl)).toBe('the real thing');
  });

  it('returns null when there is no genuine user message', () => {
    expect(firstUserMessage(line({ type: 'mode' }))).toBeNull();
    expect(firstUserMessage('')).toBeNull();
    expect(firstUserMessage('not json\n{bad')).toBeNull();
  });
});

describe('lastUserMessage', () => {
  it('returns the last genuine user message, skipping trailing assistant lines', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'first thing' } }),
      line({ type: 'user', message: { content: 'the last thing I asked' } }),
      line({ type: 'assistant', message: { content: 'working on it' } }),
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('the last thing I asked');
  });

  it('skips trailing tool-results, wrappers, and system-reminders', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'where I left off' } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
      line({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>' } }),
      line({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }),
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('where I left off');
  });

  it('tolerates a trailing partial/invalid JSON line', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'complete line' } }),
      '{"type":"user","message":{"content":"cut off',
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('complete line');
  });

  it('returns null when there is no genuine user message', () => {
    expect(lastUserMessage(line({ type: 'assistant', message: { content: 'hi' } }))).toBeNull();
    expect(lastUserMessage('')).toBeNull();
  });
});
