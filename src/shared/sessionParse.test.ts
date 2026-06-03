import { describe, it, expect } from 'vitest';
import { firstUserMessage } from './sessionParse';

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
