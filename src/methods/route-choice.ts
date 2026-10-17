import type { DecisionQuestion } from '../database/entities';
import { en } from '../i18n/en';
import { ptBR } from '../i18n/pt-BR';
import { Method, methodRoutes } from './method';
/** A task of a method that came without a route (no tag on its card): the operator picks one. */
export function routeQuestion(method: Method, language: string): DecisionQuestion {
  return {
    text: (language === 'en' ? en : ptBR)['method.whichRoute'],
    options: methodRoutes(method, language).map((r) => r.label),
  };
}
/** The route an answer names (its label or its id); undefined when it names none. */
export function routeFromAnswer(method: Method, language: string, answer: string) {
  const a = answer.trim();
  return methodRoutes(method, language).find((r) => r.label === a || r.id === a)?.id;
}
