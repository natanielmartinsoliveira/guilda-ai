import { branchKey, isSafeBranch, renderBranch } from '../src/tasks/branch';
import { branchUrl, parsePrSections, withProjectRules } from '../src/tasks/pr-description';
test('branch names come from the project pattern and stay safe', () => {
  expect(renderBranch('feature/{key}', 'PF-23986', 'x')).toBe('feature/PF-23986');
  expect(renderBranch('ai/task-{id}', '#7', 'abc')).toBe('ai/task-abc');
  expect(branchKey('#7')).toBe('7');
  expect(isSafeBranch('feature/PF-1')).toBe(true);
  for (const bad of ['master', 'MAIN', 'a..b', 'x/', '-x', 'a//b', 'x.lock', 'a b'])
    expect(isSafeBranch(bad)).toBe(false);
  expect(isSafeBranch('sandbox', ['sandbox'])).toBe(false);
});
test('the test environment URL derives from the branch key', () => {
  expect(
    branchUrl('https://{key_lower}.development.vandelay.dev/inicio', 'PF-2436', 'feature/PF-2436'),
  ).toBe('https://pf-2436.development.vandelay.dev/inicio');
  expect(branchUrl(undefined, 'PF-1', 'b')).toBe('');
});
test('the last <pr> block of the agent message fills the sections', () => {
  const message =
    'exemplo: <pr><problema>velho</problema></pr>\nfim:\n<pr>\n<problema> P </problema>\n<solucao>S</solucao>\n<como_testar>1. abrir</como_testar>\n</pr>';
  expect(parsePrSections(message)).toEqual({
    problema: 'P',
    solucao: 'S',
    como_testar: '1. abrir',
  });
  expect(parsePrSections('sem bloco')).toBeUndefined();
});
test('project rules and the PR block request are appended only when configured', async () => {
  const base = { instructions: undefined, pullRequest: {} } as never;
  expect(await withProjectRules('P', base)).toBe('P');
  const full = await withProjectRules('P', {
    instructions: 'Traduza.',
    pullRequest: { template: 't.md' },
  } as never);
  expect(full).toContain('Regras do projeto (obrigatórias):\nTraduza.');
  expect(full).toContain('<como_testar>');
});
