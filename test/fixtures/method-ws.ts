import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/** The pack folder holding test/fixtures/methods/review-gate (the company pack of the tests). */
export const METHOD_PACK = resolve(__dirname);
/** The example method of the tests, as a project configures it. */
export const EXAMPLE_METHOD = {
  name: 'review-gate',
  options: { configFrom: '/workspaces/svc', pythonPath: '/workspaces/.ai-dev-team/pylib' },
};
const HOOKS = resolve(__dirname, 'methods/review-gate/hooks');
const ok = (stdout: string) => ({ success: true, exitCode: 0, stdout, stderr: '' });
/**
 * A workspace `run` for method tests: the prepare hook answers with the review-gate.json fields
 * (it would copy the file and read it), direct.py runs for real, advance.py succeeds, and any
 * other command (the project's tests) passes.
 */
export function methodRun(config: () => Record<string, unknown>) {
  return jest.fn(async (argv: string[], opts: { input?: string } = {}) => {
    const hook =
      argv[0] === 'python3' && argv[1]?.startsWith('.ai-dev-team/method/hooks/')
        ? argv[1].split('/').pop()
        : undefined;
    if (hook === 'prepare.py') {
      const c = config();
      return ok(
        `copied\n${JSON.stringify({
          spec_root: c.spec_root ?? '',
          direct_edits: c.direct_edits === true,
        })}`,
      );
    }
    if (hook === 'direct.py') {
      const r = spawnSync('python3', [`${HOOKS}/direct.py`], {
        input: opts.input,
        encoding: 'utf8',
      });
      return {
        success: r.status === 0,
        exitCode: r.status ?? 1,
        stdout: r.stdout,
        stderr: r.stderr,
      };
    }
    if (hook === 'advance.py') return ok('{"advanced":true}');
    return ok('tests ok');
  });
}
/** The gate option of a route, as the method's own prompt file words it. */
export function authorizationFor(route: string, slug: string) {
  const file = ['feature', 'adopt', 'cleanup'].includes(route)
    ? `authorization-${route}.md`
    : 'authorization.md';
  return readFileSync(resolve(__dirname, 'methods/review-gate/prompts', file), 'utf8')
    .replace(/\{\{SLUG\}\}/g, slug)
    .trim();
}
/** After the specification step the words also authorize committing it (the feature route). */
export const authorization = (slug: string, commitSpecification = false) =>
  authorizationFor(commitSpecification ? 'feature' : 'screen', slug);
