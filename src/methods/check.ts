import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadMethod } from './method';
import { MethodRunner, MethodState } from './runner';
const caseFile = z.object({
  slug: z.string().default('slug'),
  material: z.string().default(''),
  cases: z.array(
    z.object({
      name: z.string(),
      route: z.string(),
      prompt: z.string(),
      expect: z.string(),
      state: z
        .object({
          authorization: z.string().optional(),
          notes: z.array(z.string()).optional(),
          answers: z.array(z.string()).optional(),
        })
        .optional(),
      values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      trim: z.boolean().default(false),
    }),
  ),
});
export interface CheckFailure {
  file: string;
  name: string;
  line: number;
  expected: string;
  actual: string;
}
/**
 * A method checks itself: methods/<name>/tests/*.yaml render its prompts through the engine and
 * compare them with the expected texts; tests/test_*.py (its hooks) run with python3.
 */
export async function checkMethod(packDir: string, name: string) {
  const method = loadMethod(packDir, name);
  const dir = join(method.dir, 'tests');
  const failures: CheckFailure[] = [];
  const suites: string[] = [];
  let cases = 0;
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  for (const file of files.filter((f) => f.endsWith('.yaml'))) {
    const doc = caseFile.parse(parse(readFileSync(join(dir, file), 'utf8')));
    for (const c of doc.cases) {
      cases++;
      const runner = new MethodRunner(
        {} as never,
        { id: 'check', branch: doc.slug, instructions: doc.material, tenantId: 'check' } as never,
        {
          tenant: { packDir, git: { authorName: 'check', authorEmail: 'check@example.com' } },
          cfg: {
            id: 'check',
            method: { name, options: {} },
            workspace: { type: 'coder', reference: '' },
          },
          ws: { root: '/' },
        } as never,
        c.route,
      );
      const state: MethodState = { phase: 'check', ...c.state };
      // The pack's lessons change with its use: the texts are checked without them.
      let actual = runner.render(c.prompt, { LESSONS: [], ...c.values }, state);
      if (c.trim) actual = actual.trim();
      const expected = readFileSync(join(dir, c.expect), 'utf8');
      if (actual !== expected) {
        const a = actual.split('\n');
        const e = expected.split('\n');
        let i = 0;
        while (i < Math.max(a.length, e.length) && a[i] === e[i]) i++;
        failures.push({
          file,
          name: c.name,
          line: i + 1,
          expected: e[i] ?? '',
          actual: a[i] ?? '',
        });
      }
    }
  }
  if (files.some((f) => /^test_.*\.py$/.test(f)))
    for (const file of files.filter((f) => /^test_.*\.py$/.test(f))) {
      const r = spawnSync(
        'python3',
        ['-m', 'unittest', `tests/${file.replace(/\.py$/, '')}`.replace(/\//g, '.')],
        {
          cwd: method.dir,
          encoding: 'utf8',
        },
      );
      if (r.status === 0) suites.push(`tests/${file}: ok`);
      else
        failures.push({
          file,
          name: 'python tests',
          line: 0,
          expected: 'ok',
          actual: (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n'),
        });
    }
  if (!cases && !suites.length && !failures.length)
    throw new Error(`method ${name}: nenhum caso em tests/ (no cases to check)`);
  return { cases, suites, failures };
}
