import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { porcelainPaths, readOutcome, under } from '../src/methods/runner';
import { GitService } from '../src/git/git.service';
import { ProcessRunnerService } from '../src/agents/process-runner.service';

/** The engine's own pieces around the hooks (the example method's hooks: method-check.spec). */
const sh = (cwd: string, cmd: string) => execFileSync('sh', ['-c', cmd], { cwd }).toString();
let root: string;
beforeEach(async () => {
  root = await mkdtemp('/tmp/method-hooks-');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('only an explicit "concluido" counts as done; anything else is a stop with what is pending', () => {
  expect(readOutcome('report...\n<resultado>concluido</resultado>')).toEqual({ done: true });
  expect(
    readOutcome('x<resultado>parado</resultado><pendencias>Decide the field name</pendencias>'),
  ).toEqual({ done: false, pending: 'Decide the field name', options: [] });
  expect(readOutcome('Finished without a mark.')).toEqual({
    done: false,
    pending: 'Finished without a mark.',
    options: [],
  });
  expect(readOutcome(undefined)).toEqual({ done: false, pending: '(sem relatório)', options: [] });
});

test('a stop may bring the choices for the person: one per line, bullets dropped, at most four', () => {
  const message = [
    '<resultado>parado</resultado><pendencias>Field name</pendencias>',
    '<opcoes>',
    '- Use valid_until (recomendado)',
    '2. Use expires_at',
    '',
    '* Use valid_until (recomendado)',
    '3) Keep both',
    '- Ask the team',
    '- One too many',
    '</opcoes>',
  ].join('\n');
  expect(readOutcome(message)).toEqual({
    done: false,
    pending: 'Field name',
    options: ['Use valid_until (recomendado)', 'Use expires_at', 'Keep both', 'Ask the team'],
  });
});

test('porcelain paths and paths under a folder', () => {
  expect(porcelainPaths('?? docs/spec/a b.md\0 M app/X.php\0R  new.md\0old.md\0')).toEqual([
    'docs/spec/a b.md',
    'app/X.php',
    'new.md',
  ]);
  expect(under('docs/spec/a.md', 'docs/spec')).toBe(true);
  expect(under('docs/specification/a.md', 'docs/spec')).toBe(false);
  expect(under('docs/my spec/x.md', 'docs/my spec/')).toBe(true);
  // git output is trimmed: the first entry may have lost its leading space (" M x" → "M x")
  expect(porcelainPaths('M docs/spec/node.log.md\0 M app/X.php\0')).toEqual([
    'docs/spec/node.log.md',
    'app/X.php',
  ]);
  expect(porcelainPaths('R new.md\0old.md\0?? z.md\0')).toEqual(['new.md', 'z.md']);
  expect(porcelainPaths('MM both.md\0A  added.md\0')).toEqual(['both.md', 'added.md']);
});

test('with real git: commitPaths commits only the given folder, even with spaces', async () => {
  const runner = new ProcessRunnerService({
    getRepository: () => ({ save: async () => ({ id: 'r' }), update: async () => undefined }),
  } as never);
  sh(
    root,
    'git init -q -b b && git -c user.name=a -c user.email=a@a commit -q --allow-empty -m base',
  );
  await mkdir(`${root}/docs/my spec`, { recursive: true });
  await writeFile(`${root}/docs/my spec/rule.md`, 'r');
  await writeFile(`${root}/stray.php`, 'x');
  const t = { id: 't', tenantId: 'acme', branch: 'b', workspace: root } as never;
  await new GitService(runner).commitPaths(t, ['docs/my spec'], 'spec b', {
    name: 'AI',
    email: 'ai@x',
  });
  expect(sh(root, 'git log -1 --format=%s%n%an')).toBe('spec b\nAI\n');
  expect(sh(root, 'git show --name-only --format= HEAD').trim()).toBe('docs/my spec/rule.md');
  expect(sh(root, 'git status --porcelain').trim()).toBe('?? stray.php');
});
