import type { DecisionQuestion } from '../database/entities';
import { en } from '../i18n/en';
import { ptBR } from '../i18n/pt-BR';
import { Method, methodRoutes } from './method';
const texts = (language: string) => (language === 'en' ? en : ptBR);
const labelIn = (label: string | Record<string, string>, language: string) =>
  typeof label === 'string' ? label : (label[language] ?? Object.values(label)[0]);
/** The route the card suggests, by the method's triage (first rule that finds the card). */
export function triageCard(method: Method, card: string, language: string) {
  const t = method.triage;
  if (!t) return undefined;
  const rule = t.rules.find((r) => new RegExp(r.when, 'i').test(card)) ?? t.fallback;
  return rule && { route: rule.route, risk: rule.risk, why: labelIn(rule.why, language) };
}
/**
 * A task of a method that came without a route (no tag on its card): the operator picks one.
 * With a triage suggestion, the question says which route and why, and lists it first.
 */
export function routeQuestion(
  method: Method,
  language: string,
  suggestion?: ReturnType<typeof triageCard>,
): DecisionQuestion {
  const m = texts(language);
  const routes = methodRoutes(method, language);
  const suggested = suggestion && routes.find((r) => r.id === suggestion.route);
  if (!suggestion || !suggested)
    return { text: m['method.whichRoute'], options: routes.map((r) => r.label) };
  return {
    text: `${m['method.whichRoute']}\n\n${m['method.suggestion']
      .replace('{route}', suggested.label)
      .replace('{risk}', m[`method.risk.${suggestion.risk}`])
      .replace('{why}', suggestion.why)}`,
    options: [
      `${suggested.label}${m['method.recommended']}`,
      ...routes.filter((r) => r !== suggested).map((r) => r.label),
    ],
  };
}
/** The route an answer names (its label, with or without the recommendation mark, or its id). */
export function routeFromAnswer(method: Method, language: string, answer: string) {
  const mark = texts(language)['method.recommended'];
  const a = answer.trim();
  const plain = a.endsWith(mark.trim()) ? a.slice(0, -mark.trim().length).trim() : a;
  return methodRoutes(method, language).find((r) => r.label === plain || r.id === plain)?.id;
}
