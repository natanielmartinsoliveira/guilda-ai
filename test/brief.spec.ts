import { mapBrief, readBrief } from '../src/methods/brief';
const BRIEF = {
  summary: 'Approve the discount rule',
  recommendation: { approve: true, why: 'it follows the card' },
  choices: [{ question: 'Discount cap', options: ['10%', '20%'], recommended: 0 }],
  risks: [{ level: 'low', text: 'no test for the cap yet' }],
  highlights: ['one rule changes'],
};
const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
test('the brief is the last json block of the answer', () => {
  expect(
    readBrief(`Draft:\n${block({ ...BRIEF, summary: 'old' })}\nFinal:\n${block(BRIEF)}`),
  ).toEqual(BRIEF);
});
test('the lists a brief may leave out are empty', () => {
  const { choices, risks, highlights, ...core } = BRIEF;
  expect([choices, risks, highlights].every(Boolean)).toBe(true);
  expect(readBrief(block(core))).toEqual({ ...core, choices: [], risks: [], highlights: [] });
});
test.each([
  ['no answer', undefined],
  ['no json block', 'Approve it.'],
  ['broken json', '```json\n{"summary": \n```'],
  ['no summary', block({ ...BRIEF, summary: '' })],
  [
    'a recommended choice that is no option',
    block({ ...BRIEF, choices: [{ ...BRIEF.choices[0], recommended: 2 }] }),
  ],
  [
    'a choice with one option',
    block({ ...BRIEF, choices: [{ question: 'q', options: ['a'], recommended: 0 }] }),
  ],
  ['an unknown risk level', block({ ...BRIEF, risks: [{ level: 'critical', text: 'x' }] })],
])('%s is no brief', (_name, message) => {
  expect(readBrief(message)).toBeUndefined();
});
test('every text of a brief goes through the redaction, nothing else changes', () => {
  const brief = readBrief(block({ ...BRIEF, choices: [{ ...BRIEF.choices[0], why: 'w' }] }))!;
  const upper = mapBrief(brief, (t) => t.toUpperCase());
  expect(upper.summary).toBe('APPROVE THE DISCOUNT RULE');
  expect(upper.choices[0]).toEqual({
    question: 'DISCOUNT CAP',
    options: ['10%', '20%'],
    recommended: 0,
    why: 'W',
  });
  expect(upper.risks[0]).toEqual({ level: 'low', text: 'NO TEST FOR THE CAP YET' });
  expect(upper.recommendation.approve).toBe(true);
  expect(upper.highlights).toEqual(['ONE RULE CHANGES']);
});
