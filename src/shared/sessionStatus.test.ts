import { describe, it, expect } from 'vitest';
import { stripAnsi, hasPromptPattern, hasWorkingSpinner, computeActivity, WORKING_MS, IDLE_MS } from './sessionStatus';

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

describe('hasWorkingSpinner', () => {
  // Real frames captured from claude v2.1.179: the working status line animates a star-spinner
  // glyph (✻/✶/✢/✽ …) that is absent at the idle ❯ prompt. (This version shows NO "esc to interrupt".)
  const workingTail = '4 MCPs ⏵⏵ auto mode on (shift+tab to cycle) /rc active ✢Gesticulating…9 *Gesticulating…716';
  const idleTail = '[Opus 4.8 (1M context)] │ devdeck +devdeck git:(main*) Context ░░░░░░░░░░ 0% 4 MCPs ⏵⏵ auto mode on · ← for agents /rc active ❯ ';
  it('detects the claude star-spinner glyph (agent working)', () => {
    expect(hasWorkingSpinner(workingTail)).toBe(true);
  });
  it('is false at the idle prompt (ASCII * in git status / · middot are not spinner glyphs)', () => {
    expect(hasWorkingSpinner(idleTail)).toBe(false);
  });
  it('only inspects the recent tail — a spinner that scrolled far back does not count', () => {
    const scrolledBack = '✻ Gesticulating…' + ' '.repeat(400) + idleTail;
    expect(hasWorkingSpinner(scrolledBack)).toBe(false);
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
  it('hysteresis: was working + brief output gap (no prompt) => stays working', () => {
    // 5s since data: past WORKING_MS but the agent was working and only briefly went quiet
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'working' })).toBe('working');
    // without the prior 'working' it would be your turn
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'turn' })).toBe('turn');
  });
  it('hysteresis: a prompt appears => done, not sticky-working', () => {
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'working', recentOutput: '❯ 1. Yes' })).toBe('attention');
  });
  it('hysteresis: long silence (>= sticky) => turn even if it was working', () => {
    expect(computeActivity({ ...base, now: 1000 + 11_000, prev: 'working' })).toBe('turn');
  });
  it('spinnerReliable (Claude): was working but spinner is gone => turn NOW, not 작업중 for 10s', () => {
    // For Claude the spinner reliably marks "working" (step 5), so once it's absent the turn is the
    // user's — the timing hysteresis must NOT keep it 작업중 for WORKING_STICKY_MS after a turn ends.
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'working', spinnerReliable: true })).toBe('turn');
    // agents whose spinner we can't match (Antigravity/Codex) still get the timing fallback
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'working', spinnerReliable: false })).toBe('working');
  });
  it('spinnerReliable (Claude): spinner still on screen => working (positive signal unaffected)', () => {
    expect(computeActivity({ ...base, now: 1000 + 5000, prev: 'working', spinnerReliable: true, recentOutput: '✢Gesticulating…' })).toBe('working');
  });
  it('stopped >= idle => idle', () => {
    expect(computeActivity({ ...base, now: 1000 + IDLE_MS })).toBe('idle');
  });

  // Content-based detection (real captured claude v2.1.179 frames). The working spinner is the LAST
  // thing rendered during a long silent tool/think/API gap → must read 'working', not flip to your-turn.
  const spinnerTail = '⏵⏵ auto mode on (shift+tab to cycle) /rc active ✢Gesticulating…9 *Gesticulating…716';
  const idleTail = '[Opus 4.8 (1M context)] │ devdeck +devdeck git:(main*) Context ░░░░░░░░░░ 0% 4 MCPs · ← for agents /rc active ❯ ';
  it('content-based: long silence but the working spinner is still on screen => working (freeze-proof)', () => {
    // 20s since the last byte (past WORKING_STICKY_MS) — timing alone says "your turn", but the
    // agent's frozen spinner frame is still on screen, so it is genuinely still working.
    expect(computeActivity({ ...base, now: 1000 + 20_000, prev: 'working', recentOutput: spinnerTail })).toBe('working');
  });
  it('content-based: a frozen spinner reads as working even if prev was not working', () => {
    expect(computeActivity({ ...base, now: 1000 + 20_000, prev: 'idle', recentOutput: spinnerTail })).toBe('working');
  });
  it('content-based: idle prompt + long silence => turn (no false working)', () => {
    expect(computeActivity({ ...base, now: 1000 + 20_000, prev: 'working', recentOutput: idleTail })).toBe('turn');
  });
  it('a confirmation prompt outranks a lingering spinner => attention', () => {
    expect(computeActivity({ ...base, now: 1000 + 20_000, prev: 'working', recentOutput: '✻ Gesticulating… ❯ 1. Yes' })).toBe('attention');
  });
});
