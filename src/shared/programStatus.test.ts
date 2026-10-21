import { describe, expect, it } from 'vitest';
import { activityFromProgramStatus, hasProgramStatusProbe, parseProgramStatus, PROGRAM_STATUS_PROBE } from './programStatus';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('parseProgramStatus', () => {
  it('reads the states Claude Code 2.1.306 was seen sending', () => {
    // Recorded live: idle at start, working on the prompt, done with what it did.
    expect(parseProgramStatus('state=idle:app=claude-code')).toEqual({ state: 'idle', kind: null, progress: null, msg: null });
    expect(parseProgramStatus('state=working:app=claude-code:progress=42')).toMatchObject({ state: 'working', progress: 42 });
    expect(parseProgramStatus(`state=done:app=claude-code:msg=${b64('replied OK as requested')}`)).toMatchObject({ state: 'done', msg: 'replied OK as requested' });
  });

  it('says why it is blocked, and keeps only kinds it knows', () => {
    expect(parseProgramStatus('state=blocked:app=claude-code:kind=permission')).toMatchObject({ state: 'blocked', kind: 'permission' });
    expect(parseProgramStatus('state=blocked:app=claude-code:kind=question')).toMatchObject({ kind: 'question' });
    expect(parseProgramStatus('state=blocked:app=claude-code:kind=somethingnew')).toMatchObject({ state: 'blocked', kind: null });
    expect(parseProgramStatus('state=working:app=claude-code:kind=permission')).toMatchObject({ kind: null });
  });

  it('decodes a message in any language', () => {
    expect(parseProgramStatus(`state=done:app=claude-code:msg=${b64('로그인 버그 수정함')}`)?.msg).toBe('로그인 버그 수정함');
  });

  it('ignores background tasks, probes, clears, other apps and junk', () => {
    for (const p of ['state=working:app=claude-code:id=task-1', '?', 'state=clear', 'state=clear:id=x', 'state=working:app=other', 'nonsense', '', 'state=dancing:app=claude-code']) {
      expect(parseProgramStatus(p), p).toBeNull();
    }
  });

  it('clamps progress', () => {
    expect(parseProgramStatus('state=working:progress=140')?.progress).toBe(100);
    expect(parseProgramStatus('state=working:progress=abc')?.progress).toBeNull();
  });
});

describe('the probe', () => {
  it('is found with either terminator', () => {
    expect(hasProgramStatusProbe(`junk${PROGRAM_STATUS_PROBE}junk`)).toBe(true);
    expect(hasProgramStatusProbe('\x1b]7501;?\x1b\\')).toBe(true);
    expect(hasProgramStatusProbe('\x1b]7501;state=idle\x07')).toBe(false);
  });
});

describe('activityFromProgramStatus', () => {
  const s = (state: 'working' | 'blocked' | 'done' | 'idle' | 'error') => ({ state, kind: null, progress: null, msg: null });
  it('maps the agent\'s word onto the sidebar\'s states', () => {
    expect(activityFromProgramStatus(s('working'), 0, 10, 100)).toBe('working');
    expect(activityFromProgramStatus(s('blocked'), 0, 10, 100)).toBe('attention');
    expect(activityFromProgramStatus(s('done'), 0, 10, 100)).toBe('turn');
    expect(activityFromProgramStatus(s('done'), 0, 500, 100)).toBe('idle');
    expect(activityFromProgramStatus(s('error'), 0, 10, 100)).toBe('turn');
  });
});
