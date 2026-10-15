import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { compareTenants, templatesByContent } from '../src/tenants/compare';
import { parse, stringify } from 'yaml';
import { loadPacks, packDirs } from '../src/tenants/packs';
import { loadTenants, tenants, tenantSecrets, useTenants } from '../src/tenants/tenants';
import { coderTenantYaml } from './fixtures/coder-tenant';

/** The fixture company as one pack item (what company.yaml holds). */
const company = (): Record<string, any> => parse(coderTenantYaml()).tenants[0];
const REQUIRES = [
  { name: 'INITECH_WS', description: 'Nome do seu workspace no Coder', example: '355-fulano' },
  { name: 'INITECH_TOKEN', description: 'Token do GitLab', secret: true },
];
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'packs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function pack(
  name: string,
  body: Record<string, any>,
  requires: unknown[] | null = REQUIRES,
) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'company.yaml'), stringify(body));
  if (requires) await writeFile(join(dir, 'requires.yaml'), stringify(requires));
  return dir;
}
/** The fixture with personal values and the token as variables. */
function personal() {
  const c = company();
  c.projects[0].workspace.name = '${INITECH_WS}';
  c.hosts[0].token = '${INITECH_TOKEN}';
  return c;
}
const env = { INITECH_WS: 'dev-ws', INITECH_TOKEN: 'glpat-123456' };

test('a pack loads exactly like the same company in tenants.yaml', async () => {
  const dir = await pack('initech', personal());
  const { tenants } = loadPacks([dir], env);
  expect(tenants.map(({ packDir, ...t }) => t)).toEqual(loadTenants(coderTenantYaml()));
  expect(tenants[0].packDir).toBe(dir);
});

test('a missing variable stops the load, naming pack, variable and what it is for', async () => {
  const dir = await pack('initech', personal());
  expect(() => loadPacks([dir], { INITECH_TOKEN: 'x' })).toThrow(
    new RegExp(`${dir}[\\s\\S]*INITECH_WS[\\s\\S]*Nome do seu workspace no Coder`),
  );
});

test('default fills a missing value; an empty default does not', async () => {
  const filled = await pack('a', personal(), [
    { name: 'INITECH_WS', description: 'ws', default: 'dev-ws' },
    { name: 'INITECH_TOKEN', description: 't', secret: true },
  ]);
  expect(
    loadPacks([filled], { INITECH_TOKEN: 'glpat-123456' }).tenants[0].projects[0].workspace,
  ).toMatchObject({ name: 'dev-ws' });
  const empty = await pack('b', personal(), [
    { name: 'INITECH_WS', description: 'ws', default: '' },
    { name: 'INITECH_TOKEN', description: 't', secret: true },
  ]);
  expect(() => loadPacks([empty], { INITECH_TOKEN: 'glpat-123456' })).toThrow(/INITECH_WS/);
});

test('a variable the pack did not declare is an error of the pack', async () => {
  const c = personal();
  c.name = '${NAO_DECLARADA}';
  const dir = await pack('initech', c);
  expect(() => loadPacks([dir], { ...env, NAO_DECLARADA: 'x' })).toThrow(
    /NAO_DECLARADA.*não declarada no requires\.yaml/,
  );
});

test('variables inside lists are interpolated too', async () => {
  const c = personal();
  c.projects[0].pullRequest = { reviewers: ['${INITECH_WS}'] };
  const dir = await pack('initech', c);
  expect(loadPacks([dir], env).tenants[0].projects[0].pullRequest.reviewers).toEqual(['dev-ws']);
});

test('relative harness and PR template paths resolve inside the pack', async () => {
  const c = company();
  c.projects[0].pullRequest = { template: 'pr.md' };
  c.projects[0].workspace = { type: 'local' };
  delete c.projects[0].delivery;
  c.harness = { path: 'harness' };
  const dir = await pack('initech', c, []);
  const [t] = loadPacks([dir], {}).tenants;
  expect(t.projects[0].pullRequest.template).toBe(join(dir, 'pr.md'));
  expect(t.harness?.path).toBe(join(dir, 'harness'));
});

test('the same company in two packs names both', async () => {
  const a = await pack('a', personal());
  const b = await pack('b', personal());
  expect(() => loadPacks([a, b], env)).toThrow(new RegExp(`initech[\\s\\S]*${a}[\\s\\S]*${b}`));
});

test('a pack without requires.yaml asks for nothing (and allows no variables)', async () => {
  const dir = await pack('initech', company(), null);
  expect(loadPacks([dir], {}).tenants[0].id).toBe('initech');
  const withVar = await pack('v', personal(), null);
  expect(() => loadPacks([withVar], env)).toThrow(/não declarada/);
});

test('values of secret variables are returned to be redacted', async () => {
  const dir = await pack('initech', personal());
  expect(loadPacks([dir], env).secrets).toEqual(['glpat-123456']);
});

test('GUILDA_PACKS: trimmed paths, trailing slashes and empty entries ignored', () => {
  expect(packDirs(' /a/ :: /b ')).toEqual(['/a', '/b']);
  expect(packDirs(undefined)).toEqual([]);
});

describe('GUILDA_PACKS', () => {
  afterEach(() => {
    delete process.env.GUILDA_PACKS;
    delete process.env.INITECH_WS;
    delete process.env.INITECH_TOKEN;
    useTenants(undefined);
  });
  test('selects the packs over tenants.yaml; their secrets are redacted', async () => {
    const dir = await pack('initech', personal());
    Object.assign(process.env, env, { GUILDA_PACKS: `${dir}/` });
    useTenants(undefined);
    expect(tenants().map((t) => t.id)).toEqual(['initech']);
    expect(tenantSecrets()).toContain('glpat-123456');
  });
  test('without it, tenants.yaml as before', () => {
    useTenants(undefined);
    expect(tenants().map((t) => t.id)).toContain('acme');
  });
});

describe('example pack and comparison', () => {
  test('the example pack loads with its own example values', () => {
    const dir = join(__dirname, '..', 'examples', 'packs', 'acme');
    const requires = parse(readFileSync(join(dir, 'requires.yaml'), 'utf8')) as {
      name: string;
      example: string;
    }[];
    const exampleEnv = Object.fromEntries(requires.map((r) => [r.name, r.example]));
    const { tenants: list } = loadPacks([dir], exampleEnv);
    expect(list.map((t) => t.id)).toEqual(['acme']);
  });
  test('compareTenants: equal → undefined; different → the first path, never the value', () => {
    const a = loadTenants(coderTenantYaml());
    expect(compareTenants(a, loadTenants(coderTenantYaml()))).toBeUndefined();
    const b = loadTenants(coderTenantYaml());
    (b[0].hosts[0] as { token: string }).token = 'other-secret-token';
    const diff = compareTenants(a, b)!;
    expect(diff).toBe('tenants[0].hosts[0].token');
    expect(diff).not.toContain('secret');
    const c = loadTenants(coderTenantYaml());
    c[0].projects.push({ ...c[0].projects[0], id: 'svc2' });
    expect(compareTenants(a, c)).toBe('tenants[0].projects (tamanho 1 ≠ 2)');
  });
});

test('two packs declaring the same variable each keep their own default', async () => {
  const a = personal();
  const b = personal();
  b.id = 'other';
  const req = (ws: string) => [
    { name: 'INITECH_WS', description: 'ws', default: ws },
    { name: 'INITECH_TOKEN', description: 't', secret: true },
  ];
  const da = await pack('a', a, req('ws-a'));
  const db = await pack('b', b, req('ws-b'));
  const list = loadPacks([da, db], { INITECH_TOKEN: 'glpat-123456' }).tenants;
  expect(list.map((t) => [t.id, (t.projects[0].workspace as { name: string }).name])).toEqual([
    ['initech', 'ws-a'],
    ['other', 'ws-b'],
  ]);
});

test('compare: PR templates count by content, wherever the file lives', async () => {
  const dir = await pack('t', {}, []);
  await writeFile(join(dir, 'pr.md'), 'same template');
  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFile(join(root, 'templates', 'pr.md'), 'same template');
  const old = loadTenants(coderTenantYaml());
  old[0].projects[0].pullRequest.template = 'templates/pr.md';
  const moved = loadTenants(coderTenantYaml());
  moved[0].projects[0].pullRequest.template = join(dir, 'pr.md');
  expect(
    compareTenants(templatesByContent(old, root), templatesByContent(moved, root)),
  ).toBeUndefined();
  await writeFile(join(dir, 'pr.md'), 'changed');
  expect(compareTenants(templatesByContent(old, root), templatesByContent(moved, root))).toBe(
    'tenants[0].projects[0].pullRequest.template',
  );
});

test('compare ignores where a company pack lives (packDir)', () => {
  const a = loadTenants(coderTenantYaml());
  const b = loadTenants(coderTenantYaml());
  b[0].packDir = '/somewhere/pack';
  expect(compareTenants(a, b)).toBeUndefined();
});
