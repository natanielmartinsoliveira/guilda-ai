import { failureAdvice, failureKind } from '../src/tasks/failure-kind';

test.each([
  ['timeout', 'Agent failed: Process timed out'],
  ['environment', 'Tests failed\nsh: composer: command not found'],
  ['environment', 'docker: Error response from daemon: pull access denied for guilda-php-gd'],
  ['environment', 'Coder inacessível (https://coder.example.com) — a VPN está ligada?'],
  ['environment', 'Ambiente do workspace: Claude Code 2.1.224 no workspace é anterior a 2.1.280'],
  [
    'environment',
    'Dependency preparation failed\nnpm ERR! network request to https://registry failed',
  ],
  ['config', 'tenants: invalid configuration\n- tenants.0.projects.0.test: expected array'],
  ['config', 'tenants: project "x", stack "php": no value for {{image}}'],
  ['tests', 'Tests failed\nFAILURES! Tests: 12, Assertions: 30, Failures: 2.'],
  ['checks', 'Security checks failed\n- semgrep: php.lang.security.injection'],
  ['git', 'Git rebase failed: CONFLICT (content): Merge conflict in src/a.ts'],
  ['agent', 'NO_CHANGES: the agent changed nothing'],
  ['agent', 'Agent failed: Claude returned invalid JSON'],
  ['tests', 'TESTS: Tests failed: boom'],
  ['checks', 'CHECKS: Security checks failed: gitleaks'],
  ['tests', 'TESTS: phpunit exited with 2'],
  ['agent', 'AGENT: Agent failed: no output'],
  ['other', 'something nobody planned for'],
])('%s ← %s', (kind, error) => {
  expect(failureKind(error)).toBe(kind);
});

test('a missing tool behind failing tests is the environment; nothing known is "other"', () => {
  expect(failureKind('Tests failed\nError: Cannot connect to the Docker daemon')).toBe(
    'environment',
  );
  expect(failureKind(null)).toBe('other');
});

test('each kind comes with the step that usually solves it and a hint', () => {
  expect(failureAdvice('sh: php: command not found')).toMatchObject({
    kind: 'environment',
    action: 'fix_then_retry',
  });
  expect(failureAdvice('Tests failed\n2 failures').action).toBe('retry_with_instructions');
  expect(failureAdvice('Git push failed: [rejected] non-fast-forward').action).toBe('retry');
  expect(failureAdvice('Tests failed').hint).toMatch(/^Testes:/);
});
