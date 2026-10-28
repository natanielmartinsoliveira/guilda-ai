import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadTenants } from '../src/tenants/tenants';
import {
  hostFor,
  insertProject,
  packStacks,
  parseRepoUrl,
  planProject,
  tryPack,
} from '../src/projects/project-add';
import { coderTenantYaml } from './fixtures/coder-tenant';

const [tenant] = loadTenants(coderTenantYaml());
const company = { projectDefaults: { host: 'gl', stack: 'php' } };
const stacks = [
  { name: 'node', detect: ['package.json'] },
  { name: 'php', detect: ['composer.json'] },
];

test('a repository URL as developers copy it: https, git@ and ssh://, GitLab subgroups too', () => {
  for (const url of [
    'https://git.example.com/shop/orders',
    'https://git.example.com/shop/orders.git',
    'git@git.example.com:shop/orders.git',
    'ssh://git@git.example.com:2244/shop/orders.git',
    'https://git.example.com/shop/orders/-/tree/main',
  ])
    expect(parseRepoUrl(url)).toEqual({ hostname: 'git.example.com', repository: 'shop/orders' });
  expect(parseRepoUrl('https://git.example.com/a/b/c.git')?.repository).toBe('a/b/c');
  expect(parseRepoUrl('not a url')).toBeUndefined();
  expect(parseRepoUrl('https://git.example.com/orders')).toBeUndefined();
  expect(hostFor(tenant.hosts, 'git.example.com')?.id).toBe('gl');
  expect(hostFor(tenant.hosts, 'github.com')).toBeUndefined();
});

test('the block takes the id, branch, reference and stack from the repository and the company', () => {
  const plan = planProject({
    tenant,
    company,
    stacks,
    url: 'git@git.example.com:shop/shop-billing.git',
    info: { defaultBranch: 'develop', files: ['package.json', 'README.md'] },
  });
  expect(plan.block).toBe(
    [
      '  - id: shop-billing',
      '    repository: shop/shop-billing',
      '    defaultBranch: develop',
      '    workspace: { reference: /workspaces/shop-billing }',
      '    stack: { name: node }',
    ].join('\n'),
  );
  expect(plan.warnings).toEqual([]);
  // the defaults' stack fits: not repeated in the project
  const php = planProject({
    tenant,
    company,
    stacks,
    url: 'https://git.example.com/shop/api',
    info: { defaultBranch: 'main', files: ['composer.json'] },
    id: 'shop-api',
  });
  expect(php.block).not.toContain('stack');
  expect(php.id).toBe('shop-api');
});

test('without the host or a fitting stack it still plans, saying what to check; duplicates are refused', () => {
  const plan = planProject({ tenant, company, stacks, url: 'https://git.example.com/shop/x' });
  expect(plan.defaultBranch).toBe('main');
  expect(plan.warnings[0]).toMatch(/default branch "main" assumed/);
  const none = planProject({
    tenant,
    company,
    stacks,
    url: 'https://git.example.com/shop/y',
    info: { defaultBranch: 'main', files: ['go.mod'] },
  });
  expect(none.warnings.join()).toMatch(/no stack of the pack fits its files, yet it gets the default stack "php"/);
  expect(() =>
    planProject({ tenant, company, stacks, url: 'https://git.example.com/shop/shop-orders' }),
  ).toThrow(/already a project/);
  expect(() =>
    planProject({ tenant, company, stacks, url: 'https://git.example.com/shop/z', id: 'svc' }),
  ).toThrow(/already exists/);
  expect(() => planProject({ tenant, company, stacks, url: 'https://github.com/shop/z' })).toThrow(
    /no host of initech serves github.com/,
  );
  expect(() =>
    planProject({ tenant, company, stacks, url: 'https://git.example.com/shop/z', stack: 'go' }),
  ).toThrow(/stack "go" is not in the pack/);
});

test('the block goes at the end of projects:, before the next section and its comments', () => {
  const text = [
    'id: acme',
    'projects:',
    '  - id: a',
    '    repository: x/a',
    '',
    '# formats of the company',
    'formats:',
    '  evidence: {}',
  ].join('\n');
  expect(insertProject(text, '  - id: b\n    repository: x/b')).toBe(
    [
      'id: acme',
      'projects:',
      '  - id: a',
      '    repository: x/a',
      '  - id: b',
      '    repository: x/b',
      '',
      '# formats of the company',
      'formats:',
      '  evidence: {}',
    ].join('\n'),
  );
  expect(insertProject('projects:\n  - id: a', '  - id: b')).toBe(
    'projects:\n  - id: a\n  - id: b',
  );
});

test('the pack is checked with the new project in a copy; the pack itself is left untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-add-pack-'));
  try {
    const raw = parse(coderTenantYaml()).tenants[0];
    await writeFile(join(root, 'company.yaml'), stringify(raw));
    await mkdir(join(root, 'stacks'));
    await writeFile(
      join(root, 'stacks', 'php.yaml'),
      stringify({ detect: ['composer.json'], prepare: ['echo', '{{id}}'], test: ['phpunit'] }),
    );
    expect(packStacks(root)).toEqual([{ name: 'php', detect: ['composer.json'] }]);
    const block =
      '      - id: billing\n        repository: shop/billing\n        host: gl\n        stack: php';
    const text = (await import('node:fs')).readFileSync(join(root, 'company.yaml'), 'utf8');
    const next = text.replace('projects:\n', `projects:\n${block.replace(/^ {4}/gm, '')}\n`);
    const loaded = tryPack(root, next, 'billing', {});
    expect(loaded).toMatchObject({ prepare: ['echo', 'billing'], test: ['phpunit'] });
    expect((await import('node:fs')).readFileSync(join(root, 'company.yaml'), 'utf8')).toBe(text);
    expect(() => tryPack(root, next.replace('stack: php', 'stack: nope'), 'billing', {})).toThrow(
      /stack "nope" not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
