import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidencePrompt } from '../src/evidence/evidence';
import { backOnly } from '../src/tasks/front-split';

/** Texts captured from the code before they became templates: the output must not change. */
const golden = (name: string) => readFile(join(__dirname, 'fixtures', 'golden', name), 'utf8');

// The <pr> request with the company's sections: test/pr-sections.spec.ts.
test('the back-only scope is the same text it was', async () => {
  expect(await backOnly()).toBe(await golden('back-only.txt'));
});

test('the evidence request is the same text it was, with and without notes', async () => {
  expect(
    await evidencePrompt({
      material: 'Mostrar o nome do plano',
      route: 'fact',
      notes: ['use a venda 1'],
      version: '1.48.2',
    }),
  ).toBe(await golden('evidence-prompt.txt'));
  expect(await evidencePrompt({ material: 'M', route: 'surface', version: '1.48.2' })).toBe(
    await golden('evidence-prompt-no-notes.txt'),
  );
});

test('a company pack can replace each of them', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'texts-'));
  await mkdir(join(pack, 'prompts'), { recursive: true });
  await writeFile(join(pack, 'prompts', 'back-only.md'), 'Only the API in this phase.');
  await writeFile(join(pack, 'prompts', 'evidence.md'), 'Prints for {{ROUTE}} with {{VERSION}}');
  expect(await backOnly(pack, 'svc')).toBe('Only the API in this phase.');
  expect(
    await evidencePrompt({ material: 'M', route: 'fact', version: '1.2.3' }, pack, 'svc'),
  ).toBe('Prints for fact with 1.2.3');
  await rm(pack, { recursive: true, force: true });
});
