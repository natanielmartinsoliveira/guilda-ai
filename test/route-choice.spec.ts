import { loadMethod, methodRoutes } from '../src/methods/method';
import { routeFromAnswer, routeQuestion } from '../src/methods/route-choice';
import { METHOD_PACK } from './fixtures/method-ws';

test('the question lists the route labels; an answer by label or id picks the route', () => {
  const m = loadMethod(METHOD_PACK, 'review-gate');
  const routes = methodRoutes(m, 'pt-BR');
  const q = routeQuestion(m, 'pt-BR');
  expect(q.text).toBe('Qual rota esta tarefa segue?');
  expect(q.options).toEqual(routes.map((r) => r.label));
  expect(routeFromAnswer(m, 'pt-BR', q.options![1])).toBe(routes[1].id);
  expect(routeFromAnswer(m, 'pt-BR', ` ${routes[0].id} `)).toBe(routes[0].id);
  expect(routeFromAnswer(m, 'pt-BR', 'qualquer coisa')).toBeUndefined();
  expect(routeQuestion(m, 'en').text).toBe('Which route does this task follow?');
});
