import { describe, expect, it } from 'vitest';
import { codexFirstUserMessage, codexLastUserMessage, codexSessionMeta, codexTailMeta, codexExecFinalMessage } from './codexParse';

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

describe('codexTailMeta', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('prefers the latest agent text and collects this turn\'s patched files, newest first', () => {
    const raw = [
      line({ type: 'event_msg', payload: { type: 'patch_apply_end', changes: { 'C:\\p\\old.ts': { type: 'update' } } } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: '다음 작업 진행' } }), // new turn → earlier edits drop
      line({ type: 'event_msg', payload: { type: 'agent_message', message: '중간 보고' } }),
      line({ type: 'event_msg', payload: { type: 'patch_apply_end', changes: { 'C:\\p\\src\\store.ts': { type: 'update' }, '/home/p/styles.css': { type: 'add' } } } }),
      line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '설정 저장 로직을 정리했습니다' } }),
    ].join('\n');
    expect(codexTailMeta(raw)).toEqual({
      assistantText: '설정 저장 로직을 정리했습니다',
      editedFiles: ['styles.css', 'store.ts'],
      userText: '다음 작업 진행',
      model: null,
      contextTokens: 0,
      contextWindow: 0,
    });
  });

  // Codex records the model AND the model's real context window per turn, so the sidebar can show a
  // 🧠 % for a Codex session without guessing (Claude needs the global 1M/200K setting for that).
  it('takes the model and context size from the latest turn', () => {
    const raw = [
      line({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } }),
      line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 90_000, cached_input_tokens: 80_000, total_tokens: 90_500 }, model_context_window: 258_400 } } }),
      line({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 130_848 }, model_context_window: 258_400 } } }),
    ].join('\n');
    const out = codexTailMeta(raw);
    // input_tokens is the FULL input; cached_input_tokens is a subset and must NOT be added to it.
    expect(out).toMatchObject({ model: 'gpt-5.6-sol', contextTokens: 130_848, contextWindow: 258_400 });
  });

  it('leaves model/context unset when the tail carries no such events', () => {
    expect(codexTailMeta(line({ type: 'event_msg', payload: { type: 'agent_message', message: '보고' } })))
      .toMatchObject({ model: null, contextTokens: 0, contextWindow: 0 });
  });

  it('falls back to a response_item assistant message when no event_msg carried the text', () => {
    const raw = line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '릴리스 준비 완료' }] } });
    expect(codexTailMeta(raw).assistantText).toBe('릴리스 준비 완료');
  });

  it('caps retained text and tolerates garbage lines', () => {
    const raw = ['not json', line({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(5000) } })].join('\n');
    expect(codexTailMeta(raw).assistantText!.length).toBeLessThanOrEqual(400);
    expect(codexTailMeta('').editedFiles).toEqual([]);
  });
});

// `codex exec --json` speaks a different schema than the rollout: thread/turn/item events.
describe('codexExecFinalMessage', () => {
  it('returns the last agent_message item text', () => {
    const out = [
      JSON.stringify({ type: 'thread.started', thread_id: '019fcaad-56ae-7703-9d67-249619dace14' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '생각 중' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '  사이드바 요약 추가  ' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 13271 } }),
    ].join('\n');
    expect(codexExecFinalMessage(out)).toBe('사이드바 요약 추가');
  });

  it('returns null when the run produced no agent message', () => {
    expect(codexExecFinalMessage(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } }))).toBeNull();
    expect(codexExecFinalMessage('not json\n')).toBeNull();
    expect(codexExecFinalMessage('')).toBeNull();
  });
});
