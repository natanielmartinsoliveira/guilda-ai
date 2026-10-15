import { en } from './en';
import { MessageKey, ptBR } from './pt-BR';
// Deliberately independent from config.ts: the tenants/packs loader uses it, and config.ts
// depends on that loader. config.ts validates GUILDA_LANG at startup.
export type Language = 'pt-BR' | 'en';
export const LANGUAGES: Language[] = ['pt-BR', 'en'];
/** The instance language (GUILDA_LANG in each dev's .env); pt-BR by default. */
export function language(): Language {
  return process.env.GUILDA_LANG === 'en' ? 'en' : 'pt-BR';
}
/** A text in the instance language; {name} filled from vars (a missing one stays visible). */
export function t(key: MessageKey, vars: Record<string, string | number> = {}) {
  const text = (language() === 'en' ? en : ptBR)[key] ?? ptBR[key];
  return text.replace(/\{([a-zA-Z]+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]),
  );
}
export type { MessageKey };
