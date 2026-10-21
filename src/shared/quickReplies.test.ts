import { describe, it, expect } from 'vitest';
import { MAX_QUICK_REPLIES, parseQuickReplyText, quickReplySlot, sanitizeQuickReplies } from './quickReplies';

describe('sanitizeQuickReplies', () => {
  it('trims, drops empties and non-strings, keeps each to one line and at most nine', () => {
    expect(sanitizeQuickReplies(['  yes ', '', 3, 'two\nlines'])).toEqual(['yes', 'two lines']);
    expect(sanitizeQuickReplies(Array.from({ length: 12 }, (_, i) => `p${i}`))).toHaveLength(MAX_QUICK_REPLIES);
    expect(sanitizeQuickReplies('not a list')).toEqual([]);
  });

  it('reads the settings field one phrase per line', () => {
    expect(parseQuickReplyText('commit it\r\n\r\n  run the tests \n')).toEqual(['commit it', 'run the tests']);
  });
});

describe('quickReplySlot', () => {
  const key = (code: string, extra: Partial<Parameters<typeof quickReplySlot>[0]> = {}) =>
    quickReplySlot({ type: 'keydown', ctrlKey: true, shiftKey: true, altKey: false, code, ...extra });

  it('maps Ctrl+Shift+1..9 by key position, whatever character Shift makes of it', () => {
    expect(key('Digit1')).toBe(0);
    expect(key('Digit9')).toBe(8);
    expect(key('Numpad3')).toBe(2);
  });

  it('leaves everything else to the terminal', () => {
    expect(key('Digit0')).toBeNull();
    expect(key('KeyA')).toBeNull();
    expect(key('Digit1', { shiftKey: false })).toBeNull();
    expect(key('Digit1', { altKey: true })).toBeNull(); // AltGr arrives as Ctrl+Alt
    expect(key('Digit1', { repeat: true })).toBeNull();
    expect(key('Digit1', { type: 'keyup' })).toBeNull();
  });
});
