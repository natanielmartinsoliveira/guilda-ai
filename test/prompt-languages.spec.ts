import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promptPath } from '../src/prompts/prompt-files';

const core = resolve('prompts');
const names = readdirSync(core).filter((n) => n.endsWith('.md'));
const read = (path: string) => readFileSync(path, 'utf8');
const placeholders = (text: string) => [...new Set(text.match(/\{\{[A-Z_]+\}\}/g) ?? [])].sort();
const tags = (text: string) =>
  [...new Set([...text.matchAll(/<\/?([a-z_]+)>/g)].map((m) => m[1]))].sort();
/** Words the code looks for inside tags (<veredito>ajustes</veredito>): never translated. */
const protocol = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/<([a-z_]+)>(concluido|pendente|aprovado|ajustes)</g)].map(
        (m) => `${m[1]}:${m[2]}`,
      ),
    ),
  ].sort();

afterEach(() => {
  process.env.GUILDA_LANG = 'pt-BR';
});

describe.each(names)('%s in English', (name) => {
  const pt = read(join(core, name));
  const enPath = join(core, 'en', name);
  test('exists', () => expect(existsSync(enPath)).toBe(true));
  test('has the same placeholders and protocol tags', () => {
    const en = read(enPath);
    expect(placeholders(en)).toEqual(placeholders(pt));
    expect(tags(en)).toEqual(tags(pt));
    expect(protocol(en)).toEqual(protocol(pt));
  });
});

describe('language in the prompt lookup', () => {
  let pack: string;
  beforeEach(async () => {
    pack = await mkdtemp(join(tmpdir(), 'lang-pack-'));
  });
  afterEach(async () => {
    await rm(pack, { recursive: true, force: true });
  });
  test('en picks the English core prompt; pt-BR the current one', () => {
    process.env.GUILDA_LANG = 'en';
    expect(promptPath('coder.md')).toBe(join(core, 'en', 'coder.md'));
    process.env.GUILDA_LANG = 'pt-BR';
    expect(promptPath('coder.md')).toBe(join(core, 'coder.md'));
  });
  test('a company prompt (in its own language) still wins over the English core (Focus 4)', async () => {
    await mkdir(join(pack, 'prompts'), { recursive: true });
    await writeFile(join(pack, 'prompts', 'coder.md'), 'da empresa');
    process.env.GUILDA_LANG = 'en';
    expect(promptPath('coder.md', pack, 'svc')).toBe(join(pack, 'prompts', 'coder.md'));
  });
});
