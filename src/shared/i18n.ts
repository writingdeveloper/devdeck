export type Dict = Record<string, string>;
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function makeTranslator(active: Dict, fallback: Dict): Translate {
  return (key, vars) => {
    const template = active[key] ?? fallback[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  };
}
