export type Dict = Record<string, string>;
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Languages the app ships translations for. Single source of truth for the code list. */
export const SUPPORTED_LANGS = ['ko', 'en', 'ja', 'zh'] as const;

/**
 * Display name for each language in its own script (endonym) — the convention used by
 * OS settings, Google, Wikipedia. A user always recognizes their own language regardless
 * of the current UI language, and there are no per-UI-language translations to maintain.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  zh: '中文',
};

/** Endonym for a language code, falling back to the uppercased code for anything unknown. */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

export function makeTranslator(active: Dict, fallback: Dict): Translate {
  return (key, vars) => {
    const template = active[key] ?? fallback[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  };
}
