import { assertTransition } from '../src/tasks/status';
test('allows successful lifecycle and retry', () => {
  assertTransition('PENDING', 'RUNNING');
  assertTransition('RUNNING', 'PENDING');
  assertTransition('RUNNING', 'SUCCESS');
});
test.each(['SUCCESS', 'FAILED', 'CANCELLED'] as const)('terminal %s cannot restart', (status) =>
  expect(() => assertTransition(status, 'RUNNING')).toThrow('Invalid task transition'),
);
test('cannot succeed before running', () =>
  expect(() => assertTransition('PENDING', 'SUCCESS')).toThrow());
test('operator retry puts failed or cancelled jobs back in the queue, never successful ones', () => {
  assertTransition('FAILED', 'PENDING');
  assertTransition('CANCELLED', 'PENDING');
  expect(() => assertTransition('SUCCESS', 'PENDING')).toThrow('Invalid task transition');
});
test('a job waiting for the operator resumes or is cancelled, never runs directly', () => {
  assertTransition('RUNNING', 'WAITING');
  assertTransition('WAITING', 'PENDING');
  assertTransition('WAITING', 'CANCELLED');
  expect(() => assertTransition('WAITING', 'RUNNING')).toThrow('Invalid task transition');
  expect(() => assertTransition('WAITING', 'SUCCESS')).toThrow('Invalid task transition');
});
test('a failed job can be cancelled by its decision', () => {
  assertTransition('FAILED', 'CANCELLED');
});
