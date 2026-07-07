import { describe, it, expect } from 'vitest';
import { decideKeyAction, selectionCellLength, type KeyLike } from './terminalKeys';

describe('selectionCellLength', () => {
  // Cell count of an xterm buffer selection, for re-select() after a height-only fit (xterm clears the
  // selection on resize; DevDeck restores it so a background fit can't break Ctrl+C-to-copy).
  it('single-line selection is end.x - start.x', () => {
    expect(selectionCellLength({ x: 2, y: 5 }, { x: 12, y: 5 }, 80)).toBe(10);
  });
  it('multi-line selection spans the full rows in between', () => {
    // (70,3) → (10,5): 10 to end of row 3, all of row 4 (80), 10 into row 5 = 100.
    expect(selectionCellLength({ x: 70, y: 3 }, { x: 10, y: 5 }, 80)).toBe(100);
  });
  it('adjacent full row', () => {
    expect(selectionCellLength({ x: 0, y: 2 }, { x: 0, y: 3 }, 80)).toBe(80);
  });
});

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
  it('Ctrl+F => find (open in-terminal search instead of sending \\x06 to the PTY)', () => {
    expect(decideKeyAction(key({ ctrlKey: true, key: 'f' }), false)).toBe('find');
    expect(decideKeyAction(key({ ctrlKey: true, key: 'F' }), true)).toBe('find');
  });
  it('Alt+F / plain f still pass through', () => {
    expect(decideKeyAction(key({ ctrlKey: true, altKey: true, key: 'f' }), false)).toBe('pass');
    expect(decideKeyAction(key({ key: 'f' }), false)).toBe('pass');
  });
});
