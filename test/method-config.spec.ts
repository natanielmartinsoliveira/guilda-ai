import { resolve } from 'node:path';
import {
  clearMethods,
  loadMethod,
  methodOptions,
  methodRoutes,
  routeOf,
} from '../src/methods/method';
import { loadTenants } from '../src/tenants/tenants';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';

const FIXTURES = resolve(__dirname, 'fixtures');
const PACK = `    packDir: ${FIXTURES}`;
const withMethod = (method: string, extra = PACK) =>
  yaml(`${CODER_PROJECT}\n        method: ${method}`, extra);

test('the example method loads with its six routes', () => {
  const m = loadMethod(FIXTURES, 'review-gate');
  expect(Object.keys(m.routes)).toEqual(['feature', 'screen', 'fix', 'adopt', 'cleanup', 'direct']);
  expect(routeOf(m, 'feature').start).toBe('spec');
  expect(routeOf(m, 'direct').flow).toBe('standard');
  expect(methodRoutes(m, 'en').find((r) => r.id === 'adopt')!.label).toMatch(/^Adopt existing/);
  expect(methodRoutes(m, 'pt-BR')[0]).toEqual({
    id: 'feature',
    label: 'Funcionalidade nova (especificação → entrega)',
  });
});

test('a project names its method; options get their defaults from the project', () => {
  const [t] = loadTenants(withMethod('{ name: review-gate, options: { pythonPath: /py } }'));
  const p = t.projects[0];
  expect(p.method).toEqual({ name: 'review-gate', options: { pythonPath: '/py' } });
  const m = loadMethod(t.packDir!, 'review-gate');
  expect(methodOptions(m, p)).toEqual({
    configFrom: '/workspaces/shop-orders',
    pythonPath: '/py',
  });
});

test.each([
  ['an unknown method', '{ name: nope }', /nope/],
  ['an unknown option', '{ name: review-gate, options: { color: blue } }', /color/],
  ['the old form', '{ type: review-gate }', /name/],
])('refuses %s', (_, method, error) => {
  expect(() => loadTenants(withMethod(method))).toThrow(error);
});

test('a method needs the company pack', () => {
  expect(() => loadTenants(withMethod('{ name: review-gate }', ''))).toThrow(/packDir|pacote/);
});

test('a required option with no default and no value is refused', () => {
  const local = CODER_PROJECT.replace('          reference: /workspaces/shop-orders\n', '');
  expect(() => loadTenants(yaml(`${local}\n        method: { name: review-gate }`, PACK))).toThrow(
    /configFrom/,
  );
});

test('requireMethod names the method every project must use', () => {
  expect(() => loadTenants(yaml(CODER_PROJECT, `${PACK}\n    requireMethod: review-gate`))).toThrow(
    /review-gate/,
  );
  expect(() =>
    loadTenants(withMethod('{ name: review-gate }', `${PACK}\n    requireMethod: review-gate`)),
  ).not.toThrow();
});

test('a method that runs in the Coder refuses a local project', () => {
  const local = yaml('        method: { name: review-gate, options: { configFrom: /x } }', PACK);
  expect(() => loadTenants(local)).toThrow(/coder workspace/);
});

test('projects without a method keep the core flow', () => {
  const [t] = loadTenants(yaml(CODER_PROJECT, PACK));
  expect(t.projects[0].method).toBeUndefined();
});

test('a method declares what its agent may read and run without approval', async () => {
  expect(loadMethod(FIXTURES, 'review-gate').agent).toEqual({
    addDirs: ['~/.method-tools'],
    allowedTools: ['Bash(python3 -B:*)', 'Bash(git status:*)'],
    sessions: true,
  });
  const { cp, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const [from, to, error] of [
    ['"~/.method-tools"', '"~/../etc"', /addDirs/],
    ['"~/.method-tools"', '"relative/dir"', /addDirs/],
    ['"Bash(git status:*)"', '"Bash(rm -rf /)\\n"', /allowedTools/],
    // after is a standard-flow route's: a method route has its own phases
    [
      '    start: spec\n',
      '    start: spec\n    after: prompts/direct-after.md\n',
      /after is for standard-flow/,
    ],
    // a triage that suggests a route the method does not have
    [
      'messages:',
      'triage: { rules: [{ when: "x", route: nope, risk: low, why: y }] }\nmessages:',
      /triage: route "nope"/,
    ],
  ] as const) {
    const pack = await mkdtemp(join(tmpdir(), 'method-agent-'));
    await cp(join(FIXTURES, 'methods'), join(pack, 'methods'), { recursive: true });
    const file = join(pack, 'methods/review-gate/method.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
    clearMethods();
    expect(() => loadMethod(pack, 'review-gate')).toThrow(error);
    await rm(pack, { recursive: true, force: true });
  }
  clearMethods();
});
