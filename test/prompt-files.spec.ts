import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { fillTemplate, promptPath, renderPrompt } from '../src/prompts/prompt-files';
import { loadPacks } from '../src/tenants/packs';
import { parse } from 'yaml';
import { coderTenantYaml } from './fixtures/coder-tenant';

let pack: string;
beforeEach(async () => {
  pack = await mkdtemp(join(tmpdir(), 'prompt-pack-'));
});
afterEach(async () => {
  await rm(pack, { recursive: true, force: true });
});

test('without a pack, the core prompt', () => {
  expect(promptPath('coder.md')).toBe(resolve('prompts', 'coder.md'));
  expect(promptPath('coder.md', undefined, 'svc')).toBe(resolve('prompts', 'coder.md'));
});

test('pack prompt over the core; project prompt over the pack', async () => {
  await mkdir(join(pack, 'prompts', 'svc'), { recursive: true });
  await writeFile(join(pack, 'prompts', 'coder.md'), 'empresa');
  expect(promptPath('coder.md', pack, 'svc')).toBe(join(pack, 'prompts', 'coder.md'));
  await writeFile(join(pack, 'prompts', 'svc', 'coder.md'), 'projeto');
  expect(promptPath('coder.md', pack, 'svc')).toBe(join(pack, 'prompts', 'svc', 'coder.md'));
  // another project of the same company still gets the company's
  expect(promptPath('coder.md', pack, 'other')).toBe(join(pack, 'prompts', 'coder.md'));
});

test('a project prompt without a company one falls back to the core for other names', async () => {
  await mkdir(join(pack, 'prompts', 'svc'), { recursive: true });
  await writeFile(join(pack, 'prompts', 'svc', 'fixer.md'), 'projeto');
  expect(promptPath('coder.md', pack, 'svc')).toBe(resolve('prompts', 'coder.md'));
  expect(promptPath('fixer.md', pack, 'svc')).toBe(join(pack, 'prompts', 'svc', 'fixer.md'));
});

test('names that could leave the prompt folders are refused', () => {
  for (const bad of ['../x.md', 'a/b.md', 'coder', 'Coder.md', '.md'])
    expect(() => promptPath(bad, pack)).toThrow(/prompt/);
  expect(() => promptPath('coder.md', pack, '../x')).toThrow(/projeto/);
});

test('renderPrompt fills {{VALUES}} and keeps unknown ones', async () => {
  await mkdir(join(pack, 'prompts'), { recursive: true });
  await writeFile(join(pack, 'prompts', 'coder.md'), 'Card {{KEY}}: {{TITLE}} {{OTHER}}');
  expect(await renderPrompt('coder.md', { KEY: 'A-1', TITLE: 'x' }, pack)).toBe(
    'Card A-1: x {{OTHER}}',
  );
});

test('the pack loader tells each company where its pack is', async () => {
  const company = parse(coderTenantYaml()).tenants[0];
  await writeFile(join(pack, 'company.yaml'), stringify(company));
  expect(loadPacks([pack], {}).tenants[0].packDir).toBe(pack);
});

describe('template sections (Review Focus 4)', () => {
  test('lists become "- item" lines; sections show only when there is something', () => {
    const tpl = 'A{{#NOTES}}\n\nAjustes:\n{{NOTES}}{{/NOTES}}{{^FILES}}\nsem arquivos{{/FILES}}';
    expect(fillTemplate(tpl, { NOTES: ['x', 'y'], FILES: [] })).toBe(
      'A\n\nAjustes:\n- x\n- y\nsem arquivos',
    );
    expect(fillTemplate(tpl, { NOTES: [], FILES: ['a'] })).toBe('A');
    expect(fillTemplate('{{#T}}tem {{T}}{{/T}}', { T: '' })).toBe('');
    expect(fillTemplate('{{#T}}tem {{T}}{{/T}}', { T: 'x' })).toBe('tem x');
  });
  test('an unclosed section or an unknown name stays as written, and values are never re-read', () => {
    expect(fillTemplate('{{#NOTES}}aberta', { NOTES: ['x'] })).toBe('{{#NOTES}}aberta');
    expect(fillTemplate('{{OTHER}} {{#OTHER}}x{{/OTHER}}', {})).toBe(
      '{{OTHER}} {{#OTHER}}x{{/OTHER}}',
    );
    expect(fillTemplate('{{A}}', { A: '{{B}} {{#B}}y{{/B}}', B: 'no' })).toBe(
      '{{B}} {{#B}}y{{/B}}',
    );
  });
});
