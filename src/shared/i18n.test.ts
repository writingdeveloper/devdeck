import { describe, it, expect } from 'vitest';
import { makeTranslator } from './i18n';

describe('makeTranslator', () => {
  const dict = { 'a.b': 'Hello {name}', 'only.ko': '한국어' };
  const fallback = { 'a.b': 'fallback', 'missing.in.active': 'EN only' };

  it('resolves a key and interpolates vars', () => {
    expect(makeTranslator(dict, fallback)('a.b', { name: 'Kim' })).toBe('Hello Kim');
  });
  it('falls back to the fallback dict, then to the key', () => {
    const t = makeTranslator(dict, fallback);
    expect(t('missing.in.active')).toBe('EN only');
    expect(t('totally.unknown')).toBe('totally.unknown');
  });
  it('leaves unmatched placeholders intact', () => {
    expect(makeTranslator({ k: 'Hi {x}' }, {})('k')).toBe('Hi {x}');
  });
});
