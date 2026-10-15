import { en } from './en';
import { ptBR, type Key } from './pt-BR';
export type Language = 'pt-BR' | 'en';
/** The panel follows the instance language (GUILDA_LANG), told by /web-api/me. */
let current: Language = 'pt-BR';
export function setLanguage(language: string | undefined) {
  current = language === 'en' ? 'en' : 'pt-BR';
  document.documentElement.lang = current;
}
export function getLanguage() {
  return current;
}
/** A text in the panel language; {name} filled from vars (a missing one stays visible). */
export function t(key: Key, vars: Record<string, string | number> = {}) {
  const text = (current === 'en' ? en : ptBR)[key] ?? ptBR[key];
  return text.replace(/\{([a-zA-Z]+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]),
  );
}
/** Dates in the panel language (pt-BR: 14/10/2026). */
export function dateText(value: Date | string | number) {
  return new Date(value).toLocaleDateString(current);
}
export type { Key };
