import { isApproval } from '../src/methods/approval';

test('plain approvals in pt-BR and en, with case, accents and end punctuation ignored', () => {
  for (const a of [
    'sim',
    'OK',
    'ok.',
    'Aprovado!',
    'aprovo',
    'autorizo',
    'pode seguir',
    'Segue',
    'pode',
    '1',
    '👍',
    '✅',
    'yes',
    'approve',
    'Approved',
    'go',
  ])
    expect(isApproval(a)).toBe(true);
});
test('anything else is not an approval', () => {
  for (const a of [
    '',
    'ok mas mude X',
    'não',
    'nao aprovado',
    'sim, e também',
    '2',
    'aprovado?',
    'go ahead and change it',
  ])
    expect(isApproval(a)).toBe(false);
});
