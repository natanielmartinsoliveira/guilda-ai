import { readFileSync } from 'node:fs';
import {
  clarificationsFrom,
  clarificationsText,
  failureReason,
  MAX_QUESTIONS,
  NeedsInput,
  parseQuestions,
} from '../src/tasks/decisions';
test('reads questions and their optional choices from the last <duvidas> block', () => {
  const message = [
    'Li o card.',
    '<duvidas>',
    '<pergunta>O motivo da recusa é obrigatório?<opcoes><opcao>Sim</opcao><opcao>Não</opcao></opcoes></pergunta>',
    '<pergunta>  Quem recebe o e-mail de recusa?  </pergunta>',
    '</duvidas>',
  ].join('\n');
  expect(parseQuestions(message)).toEqual([
    { text: 'O motivo da recusa é obrigatório?', options: ['Sim', 'Não'] },
    { text: 'Quem recebe o e-mail de recusa?' },
  ]);
});
test('no block, an empty block or blank questions mean no questions', () => {
  expect(parseQuestions('feito')).toEqual([]);
  expect(parseQuestions(undefined)).toEqual([]);
  expect(parseQuestions('<duvidas>   </duvidas>')).toEqual([]);
  expect(parseQuestions('<duvidas><pergunta>  </pergunta></duvidas>')).toEqual([]);
});
test('a block the model forgot to close is still read', () => {
  expect(parseQuestions('<duvidas><pergunta>Qual tela?</pergunta>')).toEqual([
    { text: 'Qual tela?' },
  ]);
});
test('limits sizes so a runaway answer cannot flood the operator', () => {
  const many = Array.from({ length: 15 }, (_, i) => `<pergunta>P${i}</pergunta>`).join('');
  expect(parseQuestions(`<duvidas>${many}</duvidas>`)).toHaveLength(10);
  const opts = Array.from({ length: 9 }, (_, i) => `<opcao>${i}</opcao>`).join('');
  expect(
    parseQuestions(`<duvidas><pergunta>X<opcoes>${opts}</opcoes></pergunta></duvidas>`)[0].options,
  ).toHaveLength(6);
});
test('clarifications become a prompt section, in order', () => {
  expect(clarificationsText(undefined)).toBe('');
  expect(clarificationsText([])).toBe('');
  const text = clarificationsText([
    { kind: 'answer', question: 'Motivo obrigatório?', text: 'Sim', at: 'x' },
    { kind: 'instruction', text: 'Use o enum RefusalReason', at: 'y' },
  ]);
  expect(text.startsWith('\n\nEsclarecimentos do operador')).toBe(true);
  expect(text).toContain('- Pergunta: Motivo obrigatório?\n  Resposta: Sim');
  expect(text).toContain('- Instrução: Use o enum RefusalReason');
});
test('failure reason: first meaningful line, short', () => {
  expect(failureReason('TESTS: Tests failed: \n FAIL a.spec.ts')).toBe('TESTS: Tests failed:');
  expect(failureReason('x'.repeat(500))).toHaveLength(300);
});
test('NeedsInput carries the questions; the limit is 3', () => {
  const e = new NeedsInput([{ text: 'Q?' }]);
  expect(e.questions).toEqual([{ text: 'Q?' }]);
  expect(e.message).toContain('1 question');
  expect(MAX_QUESTIONS).toBe(3);
});
test.each(['coder.md', 'subtask.md', 'reviser.md', 'planner.md'])(
  '%s tells the agent to ask instead of guessing',
  (file) => {
    const prompt = readFileSync(`prompts/${file}`, 'utf8');
    expect(prompt).toContain('<duvidas>');
    expect(prompt).toContain('NÃO implemente');
  },
);
test('clarifications come from answered decisions, in answer order', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 6, 10, m));
  const list = [
    {
      type: 'failure',
      status: 'answered',
      answeredAt: at(5),
      answer: { action: 'retry_with_instructions', instructions: 'Use o enum' },
    },
    {
      type: 'question',
      status: 'answered',
      answeredAt: at(1),
      questions: [{ text: 'Motivo obrigatório?' }, { text: 'Qual tela?' }],
      answer: { answers: ['Sim', 'Perfil'] },
    },
    { type: 'failure', status: 'answered', answeredAt: at(9), answer: { action: 'retry' } },
    {
      type: 'question',
      status: 'open',
      answeredAt: null,
      questions: [{ text: 'X?' }],
      answer: null,
    },
  ] as never;
  expect(clarificationsFrom(list).map((c) => [c.kind, c.question, c.text])).toEqual([
    ['answer', 'Motivo obrigatório?', 'Sim'],
    ['answer', 'Qual tela?', 'Perfil'],
    ['instruction', undefined, 'Use o enum'],
  ]);
});
