import { describe, it, expect } from 'vitest';
import { stripAnsi, hasPromptPattern, computeActivity, WORKING_MS, IDLE_MS } from './sessionStatus';

describe('stripAnsi', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  it('removes CSI/SGR and OSC escape sequences', () => {
    expect(stripAnsi(`${ESC}[32mHI${ESC}[0m`)).toBe('HI');
    expect(stripAnsi(`${ESC}[2J${ESC}[H${ESC}]0;window-title${BEL}> OK`)).toBe('> OK');
    expect(stripAnsi(`${ESC}]0;t${ESC}\\KEEP`)).toBe('KEEP'); // OSC terminated by ST (ESC \): both consumed, following text kept
  });
  it('leaves ordinary text (brackets, uppercase) untouched', () => {
    expect(stripAnsi('Do you want to proceed? [Y/n]')).toBe('Do you want to proceed? [Y/n]');
  });
});

describe('hasPromptPattern', () => {
  it('matches common agent confirmation prompts', () => {
    expect(hasPromptPattern('  ❯ 1. Yes')).toBe(true);
    expect(hasPromptPattern('Continue? (y/n)')).toBe(true);
    expect(hasPromptPattern('Do you want to proceed?')).toBe(true);
  });
  it('does not match ordinary output', () => {
    expect(hasPromptPattern('building project... done in 2.3s')).toBe(false);
  });
});

describe('computeActivity', () => {
  // lastInputAt far in the past so the "user typing" branch is off unless a test sets it.
  const base = { exited: false, lastDataAt: 1000, lastInputAt: -1e9, now: 1000, recentOutput: '' };
  it('exited wins', () => {
    expect(computeActivity({ ...base, exited: true })).toBe('exited');
  });
  it('recent user input => turn, NOT working (keystroke echo must not look like agent work)', () => {
    // data is fresh (would be 'working') but the user just typed → stable 'turn'
    expect(computeActivity({ ...base, lastDataAt: 1000, lastInputAt: 1000, now: 1500 })).toBe('turn');
  });
  it('recent output (no recent input) => working', () => {
    expect(computeActivity({ ...base, now: 1000 + WORKING_MS })).toBe('working');
  });
  it('stopped + prompt => attention', () => {
    expect(computeActivity({ ...base, now: 1000 + WORKING_MS + 1, recentOutput: '❯ 1. Yes' })).toBe('attention');
  });
  it('stopped, no prompt, < idle => turn', () => {
    expect(computeActivity({ ...base, now: 1000 + WORKING_MS + 1 })).toBe('turn');
  });
  it('stopped >= idle => idle', () => {
    expect(computeActivity({ ...base, now: 1000 + IDLE_MS })).toBe('idle');
  });
});
