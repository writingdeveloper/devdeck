import { describe, it, expect } from 'vitest';
import { makeTranslator, SUPPORTED_LANGS, LANGUAGE_NAMES, languageName } from './i18n';
import ko from '../renderer/locales/ko.json';
import en from '../renderer/locales/en.json';
import ja from '../renderer/locales/ja.json';
import zh from '../renderer/locales/zh.json';

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

// Every user-visible string of the multi-provider work must exist in ALL four dictionaries — a
// missing key silently falls back to English (or to the raw key), which reads as a bug in the UI.
describe('locale parity for provider + usage keys', () => {
  const REQUIRED = [
    'agent.claude', 'agent.codex', 'agent.antigravity',
    'usage.all_usage', 'usage.modal_title', 'usage.modal_refresh', 'usage.modal_close',
    'usage.summary_none', 'usage.summary_guidance', 'usage.stale_age',
    'usage.limit_session', 'usage.limit_weekly', 'usage.limit_model_weekly', 'usage.limit_primary', 'usage.limit_secondary',
    'usage.credits', 'usage.credits_balance', 'usage.credits_spent', 'usage.credits_on', 'usage.credits_off',
    'usage.guidance_cli', 'usage.copy_command',
    'usage.state_ready', 'usage.state_stale', 'usage.state_login_required', 'usage.state_expired',
    'usage.state_not_applicable', 'usage.state_cli_missing', 'usage.state_offline', 'usage.state_rate_limited', 'usage.state_unsupported',
    'usage.local_title', 'usage.local_explainer',
  ];
  const DICTS: Record<string, Record<string, string>> = {
    ko: ko as Record<string, string>, en: en as Record<string, string>,
    ja: ja as Record<string, string>, zh: zh as Record<string, string>,
  };

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang} defines every required key with a non-empty string`, () => {
      for (const key of REQUIRED) {
        expect(typeof dict[key], `${lang} missing ${key}`).toBe('string');
        expect(dict[key].trim(), `${lang} empty ${key}`).not.toBe('');
      }
    });
  }

  it('keeps the X placeholder in the stale-age template', () => {
    for (const [lang, dict] of Object.entries(DICTS)) expect(dict['usage.stale_age'], lang).toContain('X');
  });
});
