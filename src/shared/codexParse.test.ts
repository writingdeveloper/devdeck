import { describe, expect, it } from 'vitest';
import { codexFirstUserMessage, codexLastUserMessage, codexSessionMeta, codexSummarySources } from './codexParse';

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

describe('codexSummarySources', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('prefers the latest agent text and collects this turn\'s patched files, newest first', () => {
    const raw = [
      line({ type: 'event_msg', payload: { type: 'patch_apply_end', changes: { 'C:\\p\\old.ts': { type: 'update' } } } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: '다음 작업 진행' } }), // new turn → earlier edits drop
      line({ type: 'event_msg', payload: { type: 'agent_message', message: '중간 보고' } }),
      line({ type: 'event_msg', payload: { type: 'patch_apply_end', changes: { 'C:\\p\\src\\store.ts': { type: 'update' }, '/home/p/styles.css': { type: 'add' } } } }),
      line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '설정 저장 로직을 정리했습니다' } }),
    ].join('\n');
    expect(codexSummarySources(raw)).toEqual({
      assistantText: '설정 저장 로직을 정리했습니다',
      editedFiles: ['styles.css', 'store.ts'],
      userText: '다음 작업 진행',
    });
  });

  it('falls back to a response_item assistant message when no event_msg carried the text', () => {
    const raw = line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '릴리스 준비 완료' }] } });
    expect(codexSummarySources(raw).assistantText).toBe('릴리스 준비 완료');
  });

  it('caps retained text and tolerates garbage lines', () => {
    const raw = ['not json', line({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(5000) } })].join('\n');
    expect(codexSummarySources(raw).assistantText!.length).toBeLessThanOrEqual(400);
    expect(codexSummarySources('').editedFiles).toEqual([]);
  });
});
