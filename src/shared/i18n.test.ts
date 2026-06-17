import { describe, it, expect } from 'vitest';
import { makeTranslator, SUPPORTED_LANGS, LANGUAGE_NAMES, languageName } from './i18n';

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

describe('languageName', () => {
  it('gives every supported language a non-empty display name', () => {
    for (const code of SUPPORTED_LANGS) {
      expect(LANGUAGE_NAMES[code], `missing name for ${code}`).toBeTruthy();
      expect(languageName(code)).toBe(LANGUAGE_NAMES[code]);
    }
  });
  it('shows each language as its own-script endonym', () => {
    expect(languageName('ko')).toBe('한국어');
    expect(languageName('en')).toBe('English');
    expect(languageName('ja')).toBe('日本語');
    expect(languageName('zh')).toBe('中文');
  });
  it('falls back to the uppercased code for an unknown language', () => {
    expect(languageName('fr')).toBe('FR');
  });
});
