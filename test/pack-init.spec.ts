import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadPacks } from '../src/tenants/packs';
import { checkPack, packFiles, writePack } from '../src/projects/pack-init';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pack-init-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const examples = async (dir: string) =>
  Object.fromEntries(
    (
      parse(await readFile(join(dir, 'requires.yaml'), 'utf8')) as {
        name: string;
        example?: string;
      }[]
    ).map((r) => [r.name, r.example ?? 'tok-example']),
  );

test('a GitLab company on Coder: the pack loads as the core reads packs, with the first project', async () => {
  const dir = join(root, 'nova-corp');
  const files = packFiles({
    id: 'nova-corp',
    name: 'Nova Corp',
    repoUrl: 'git@git.nova.test:shop/billing-api.git',
    coder: 'https://coder.nova.test',
    language: 'pt-BR',
  });
  expect(Object.keys(files).sort()).toEqual([
    'README.md',
    'company.yaml',
    'lessons/_all.md',
    'requires.yaml',
    'stacks/node-npm.yaml',
  ]);
  checkPack(files);
  writePack(dir, files);
  const env = await examples(dir);
  expect(Object.keys(env)).toEqual([
    'NOVA_CORP_GIT_NAME',
    'NOVA_CORP_GIT_EMAIL',
    'NOVA_CORP_GITLAB_TOKEN',
    'NOVA_CORP_CODER_WORKSPACE',
  ]);
  const { tenants } = loadPacks([dir], env);
  const [t] = tenants;
  expect(t).toMatchObject({ id: 'nova-corp', name: 'Nova Corp' });
  expect(t.hosts[0]).toMatchObject({
    type: 'gitlab',
    baseUrl: 'https://git.nova.test',
    sshUrl: 'ssh://git.nova.test',
  });
  expect(t.projects[0]).toMatchObject({
    id: 'billing-api',
    repository: 'shop/billing-api',
    delivery: 'rehearsal',
    workspace: { type: 'coder', reference: '/workspaces/billing-api', protect: ['/workspaces'] },
  });
  // until its test is set, a task of the project fails saying so
  expect(t.projects[0].test.join(' ')).toContain('set the test command');
  expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('npm run project:add');
});

test('a GitHub company without Coder; the example stack loads when a project names it', async () => {
  const dir = join(root, 'acme');
  const files = packFiles({
    id: 'acme',
    name: 'Acme',
    repoUrl: 'https://github.com/acme/site',
    language: 'en',
  });
  writePack(dir, files);
  const company = (await readFile(join(dir, 'company.yaml'), 'utf8')).replace(
    '    test: [sh, -c, \'echo "set the test command of this project in company.yaml" >&2; exit 1\']',
    '    stack: { name: node-npm }',
  );
  await writeFile(join(dir, 'company.yaml'), company);
  const { tenants } = loadPacks([dir], await examples(dir));
  expect(tenants[0].hosts[0]).toMatchObject({ id: 'github', type: 'github' });
  expect(tenants[0].projects[0]).toMatchObject({
    id: 'site',
    delivery: 'normal',
    workspace: { type: 'local' },
  });
  expect(tenants[0].projects[0].test[2]).toBe(
    'docker run --rm --network none -v "$PWD":/app -w /app node:22 npm test',
  );
});

test('a bad id, a non-https Coder, a folder with files or Coder on GitHub are refused', async () => {
  const base = { name: 'X', repoUrl: 'https://git.x.test/a/b', language: 'en' as const };
  expect(() => packFiles({ ...base, id: 'Bad Id' })).toThrow(/invalid company id/);
  expect(() => packFiles({ ...base, id: 'x', coder: 'http://coder.x' })).toThrow(/https/);
  expect(() => packFiles({ ...base, id: 'x', repoUrl: 'nope' })).toThrow(/not a repository URL/);
  // Coder clones over ssh with the workspace key: a GitLab host only (the core's own rule)
  expect(() =>
    checkPack(
      packFiles({ ...base, id: 'x', repoUrl: 'https://github.com/a/b', coder: 'https://c.x' }),
    ),
  ).toThrow(/gitlab/);
  await mkdir(join(root, 'busy'));
  await writeFile(join(root, 'busy', 'f'), 'x');
  expect(() => writePack(join(root, 'busy'), packFiles({ ...base, id: 'x' }))).toThrow(
    /already has files/,
  );
});
