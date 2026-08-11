import { describe, it, expect } from 'vitest';
import { firstUserMessage, lastUserMessage, stripAttachmentNoise } from './sessionParse';

// Pasting a screenshot leaves only the agent's attachment bookkeeping behind, and DevDeck's own Ctrl+V
// handler writes that temp path — so the newest "user message" became a temp filename, and that is what
// the deck row offered as the answer to "what was I doing here?".
describe('stripAttachmentNoise', () => {
  it('removes the attachment marker and keeps the prose around it', () => {
    expect(stripAttachmentNoise('[Image: source: C:\Users\me\AppData\Local\Temp\devdeck-paste-abc-123.png] 이 부분 좀 봐주세요'))
      .toBe('이 부분 좀 봐주세요');
    expect(stripAttachmentNoise('여기 보세요 [Image: screenshot.png] 그리고 저기도'))
      .toBe('여기 보세요 그리고 저기도');
    // The agent also writes an already-numbered form for images it has seen before.
    expect(stripAttachmentNoise('[Image #4] 이 부분 확인해주세요')).toBe('이 부분 확인해주세요');
  });
  it('does not eat words that merely begin with "image"', () => {
    expect(stripAttachmentNoise('[Imagenet] 벤치마크 결과')).toBe('[Imagenet] 벤치마크 결과');
  });
  it('reduces a bare paste to nothing, so the caller can fall back to a real message', () => {
    expect(stripAttachmentNoise('[Image: source: /tmp/devdeck-paste-9f2c4d1e-aaaa-bbbb-cccc-1234567890ab.png]')).toBe('');
    expect(stripAttachmentNoise('C:\Temp\devdeck-paste-9f2c-4d1e.png ')).toBe('');
  });
  it('leaves ordinary text alone, including unrelated file paths', () => {
    expect(stripAttachmentNoise('src/renderer/shell.ts 를 고쳐주세요')).toBe('src/renderer/shell.ts 를 고쳐주세요');
    expect(stripAttachmentNoise('배포까지 진행해주세요')).toBe('배포까지 진행해주세요');
  });
});

describe('resume cue falls past a bare screenshot paste', () => {
  const line = (text: string): string => JSON.stringify({ type: 'user', message: { content: text } });
  it('answers with the last thing the user actually said', () => {
    const log = [
      line('사이드바 정렬을 바꿔주세요'),
      line('[Image: source: C:\\Temp\\devdeck-paste-1a2b3c4d.png]'),
    ].join('\n');
    expect(lastUserMessage(log)).toBe('사이드바 정렬을 바꿔주세요');
  });
});

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

  it('skips harness-injected notification messages and returns the next genuine message', () => {
    const jsonl = [
      line({ type: 'user', message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT] session resumed' } }),
      line({ type: 'user', message: { content: '<task-notification>background task finished</task-notification>' } }),
      line({ type: 'user', message: { content: '어제 하던 작업을 이어서' } }),
    ].join('\n');
    expect(firstUserMessage(jsonl)).toBe('어제 하던 작업을 이어서');
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

  it('skips a trailing harness-injected notification and returns the previous genuine message', () => {
    const jsonl = [
      line({ type: 'user', message: { content: '이어서 작업해줘' } }),
      line({ type: 'user', message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT] context compacted' } }),
      line({ type: 'user', message: { content: '<task-notification>reminder fired</task-notification>' } }),
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('이어서 작업해줘');
  });
});
