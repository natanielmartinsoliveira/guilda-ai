import { renderBranch, slugify } from '../src/tasks/branch';
test('slug: lowercase ascii, hyphens, 50 chars, never empty', () => {
  expect(slugify('Fix Billing: payment options / fidelity')).toBe(
    'fix-billing-payment-options-fidelity',
  );
  expect(slugify('Ação em promoção já expirada!')).toBe('acao-em-promocao-ja-expirada');
  expect(slugify('  --Olá--  ')).toBe('ola');
  expect(slugify('')).toBe('task');
  expect(slugify('!!!')).toBe('task');
  const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
  expect(long.length).toBeLessThanOrEqual(50);
  expect(long.endsWith('-')).toBe(false);
  expect(slugify('a'.repeat(49) + ' bc')).toBe('a'.repeat(49));
});
test('{slug} in the branch pattern', () => {
  expect(renderBranch('{key}-{slug}', '49145', 'id', 'Fix billing payment')).toBe(
    '49145-fix-billing-payment',
  );
  expect(renderBranch('feature/{key}', 'PF-1', 'id')).toBe('feature/PF-1');
});
