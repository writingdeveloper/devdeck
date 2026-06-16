import { describe, it, expect } from 'vitest';
import { decideKeyAction, type KeyLike } from './terminalKeys';

const key = (over: Partial<KeyLike>): KeyLike => ({ type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, key: '', ...over });

describe('decideKeyAction', () => {
  it('Ctrl+C with a selection => copy (not SIGINT)', () => {
    expect(decideKeyAction(key({ ctrlKey: true, key: 'c' }), true)).toBe('copy');
    expect(decideKeyAction(key({ ctrlKey: true, key: 'C' }), true)).toBe('copy');
  });
  it('Ctrl+C with NO selection => pass (interrupt still works)', () => {
    expect(decideKeyAction(key({ ctrlKey: true, key: 'c' }), false)).toBe('pass');
  });
  it('Ctrl+Shift+C with a selection => copy', () => {
    expect(decideKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'C' }), true)).toBe('copy');
  });
  it('Ctrl+V / Ctrl+Shift+V => paste', () => {
    expect(decideKeyAction(key({ ctrlKey: true, key: 'v' }), false)).toBe('paste');
    expect(decideKeyAction(key({ ctrlKey: true, shiftKey: true, key: 'V' }), false)).toBe('paste');
  });
  it('Alt-modified combos are never hijacked', () => {
    expect(decideKeyAction(key({ ctrlKey: true, altKey: true, key: 'c' }), true)).toBe('pass');
    expect(decideKeyAction(key({ ctrlKey: true, altKey: true, key: 'v' }), false)).toBe('pass');
  });
  it('plain keys and non-ctrl combos pass through', () => {
    expect(decideKeyAction(key({ key: 'c' }), true)).toBe('pass');
    expect(decideKeyAction(key({ shiftKey: true, key: 'v' }), false)).toBe('pass');
  });
  it('only keydown is acted on (keyup/keypress pass)', () => {
    expect(decideKeyAction(key({ type: 'keyup', ctrlKey: true, key: 'c' }), true)).toBe('pass');
  });
  it('ignores auto-repeat (held key must not copy/paste repeatedly)', () => {
    expect(decideKeyAction(key({ ctrlKey: true, key: 'v', repeat: true }), false)).toBe('pass');
    expect(decideKeyAction(key({ ctrlKey: true, key: 'c', repeat: true }), true)).toBe('pass');
  });
});
