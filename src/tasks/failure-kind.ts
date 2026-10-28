import { t, type MessageKey } from '../i18n';
/**
 * What kind of problem stopped a task, read from its error: what to do next depends on it (an
 * environment problem is fixed there and retried as is; a failing test needs instructions).
 */
export type FailureKind =
  'timeout' | 'environment' | 'config' | 'tests' | 'checks' | 'git' | 'agent' | 'other';
/** The operator's next step that usually solves it. */
export type FailureAction = 'retry' | 'retry_with_instructions' | 'fix_then_retry';
// Order matters: a test command that fails because a tool is missing is an environment
// problem, not a failing test; a timeout is a timeout whatever ran.
const KINDS: [Exclude<FailureKind, 'other'>, RegExp][] = [
  ['timeout', /Process timed out|Output limit exceeded|\btimed out\b|tempo esgotado/i],
  [
    'environment',
    /command not found|: not found\b|No such file or directory|Cannot connect to the Docker daemon|pull access denied|manifest unknown|Unable to find image|permission denied|EACCES|ENOENT|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable|Could not resolve host|Could not read from remote repository|Host key verification failed|Coder inacess|coder login|Sessão do Coder|Workspace \S+ parado|not logged in|Ambiente do workspace|Dependency preparation failed/i,
  ],
  [
    'config',
    /invalid configuration|needs the company pack|not found \(stacks\/\)|no value for \{\{|references unknown|has no credentials|No AI credential allowed/i,
  ],
  ['tests', /^(?:[A-Z_]+: )?(Tests failed|Quality gate failed)/m],
  ['checks', /^(?:[A-Z_]+: )?Security checks failed/m],
  [
    'git',
    /\bGit \w+ failed|CONFLICT|merge conflict|non-fast-forward|\[rejected\]|Workspace branch changed|branch base mudou|base branch changed/i,
  ],
  ['agent', /^(?:[A-Z_]+: )?Agent failed|NO_CHANGES|returned invalid JSON|Method failed/m],
];
/** The worker writes "STAGE: message": a failure no pattern knows still tells where it was. */
const BY_STAGE: Record<string, FailureKind> = { TESTS: 'tests', CHECKS: 'checks' };
export function failureKind(error: string | null | undefined): FailureKind {
  if (!error) return 'other';
  const known = KINDS.find(([, re]) => re.test(error))?.[0];
  if (known) return known;
  return BY_STAGE[/^([A-Z_]+): /.exec(error)?.[1] ?? ''] ?? 'other';
}
const ACTIONS: Record<FailureKind, FailureAction> = {
  timeout: 'retry',
  environment: 'fix_then_retry',
  config: 'fix_then_retry',
  tests: 'retry_with_instructions',
  checks: 'retry_with_instructions',
  git: 'retry',
  agent: 'retry_with_instructions',
  other: 'retry_with_instructions',
};
/** The kind, the step that usually solves it and what to tell the operator. */
export function failureAdvice(error: string | null | undefined) {
  const kind = failureKind(error);
  return { kind, action: ACTIONS[kind], hint: t(`failure.kind.${kind}` as MessageKey) };
}
