import { makeTranslator, type Translate } from '../shared/i18n';
import ko from './locales/ko.json';
import en from './locales/en.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';

const DICTS: Record<string, Record<string, string>> = { ko, en, ja, zh };
const LOCALE_TAG: Record<string, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };

let current = 'en';
let t: Translate = makeTranslator(en, en);

export function setLanguage(lang: string): void {
  current = DICTS[lang] ? lang : 'en';
  t = makeTranslator(DICTS[current], en);
}
export function tr(key: string, vars?: Record<string, string | number>): string { return t(key, vars); }
export function currentLang(): string { return current; }
export function localeTag(): string { return LOCALE_TAG[current] ?? 'en-US'; }
export const SUPPORTED = ['ko', 'en', 'ja', 'zh'];
