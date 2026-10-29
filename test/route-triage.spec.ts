import { routeFromAnswer, routeQuestion, triageCard } from '../src/methods/route-choice';
import type { Method } from '../src/methods/method';

const method = {
  routes: {
    fact: { label: { 'pt-BR': 'Regra de negócio', en: 'Business rule' } },
    direct: { label: { 'pt-BR': 'Direta', en: 'Direct' } },
  },
  triage: {
    rules: [
      {
        when: '\\b(testes?|tests?|documenta|débito técnico)\\b',
        route: 'direct',
        risk: 'low',
        why: { 'pt-BR': 'testes ou documentação sem mudar comportamento', en: 'tests or docs' },
      },
    ],
    fallback: { route: 'fact', risk: 'medium', why: 'feature ou regra de negócio' },
  },
} as unknown as Method;

test('the first rule that finds the card suggests the route; otherwise the fallback', () => {
  expect(triageCard(method, 'Débito técnico: criar testes unitários do X', 'pt-BR')).toEqual({
    route: 'direct',
    risk: 'low',
    why: 'testes ou documentação sem mudar comportamento',
  });
  expect(triageCard(method, 'Nova tela de faturamento', 'pt-BR')?.route).toBe('fact');
  expect(triageCard({ ...method, triage: undefined } as Method, 'x', 'pt-BR')).toBeUndefined();
});

test('the question says the suggestion and why; it comes first, marked, and the mark is understood', () => {
  const q = routeQuestion(method, 'pt-BR', triageCard(method, 'criar testes', 'pt-BR'));
  expect(q.text).toBe(
    'Qual rota esta tarefa segue?\n\nSugestão: Direta — risco baixo: testes ou documentação sem mudar comportamento',
  );
  expect(q.options).toEqual(['Direta (recomendado)', 'Regra de negócio']);
  expect(routeFromAnswer(method, 'pt-BR', 'Direta (recomendado)')).toBe('direct');
  expect(routeFromAnswer(method, 'pt-BR', 'Regra de negócio')).toBe('fact');
  // without triage the question is as before
  expect(routeQuestion(method, 'pt-BR').options).toEqual(['Regra de negócio', 'Direta']);
});
