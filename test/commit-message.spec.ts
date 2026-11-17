import { stepCommit } from '../src/tasks/task-worker.service';
test('the commit message follows the project pattern, or keeps the default without one', () => {
  expect(stepCommit('PF-25079', '[MIG] Criar coluna', 'feat({key}): {title}')).toBe(
    'feat(PF-25079): [MIG] Criar coluna',
  );
  expect(stepCommit('PF-25079', '[MIG] Criar coluna')).toBe(
    'feat(ai): PF-25079 [MIG] Criar coluna',
  );
  // A title holding a placeholder is not expanded again.
  expect(stepCommit('PF-1', 'usa {key}', '{key} {title}')).toBe('PF-1 usa {key}');
  expect(stepCommit('PF-1', 'x'.repeat(300), '{key} {title}')).toHaveLength(200);
});
