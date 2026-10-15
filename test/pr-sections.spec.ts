import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_FORMATS, PrSection } from '../src/formats/formats';
import {
  parsePrSections,
  prSectionsRequest,
  renderPrTemplate,
  withProjectRules,
} from '../src/tasks/pr-description';

const golden = (name: string) => readFile(join(__dirname, 'fixtures', 'golden', name), 'utf8');
/** The five sections the operator's company asks for today (they move to its pack). */
const COMPANY: PrSection[] = [
  ...DEFAULT_FORMATS.pullRequest.sections,
  {
    tag: 'banco',
    placeholder: 'DATABASE',
    ask: '"Não" ou, se for preciso executar algo no banco de produção, o script completo',
    fallback: 'Não',
    kind: 'text',
  },
  {
    tag: 'traducoes',
    placeholder: 'TRANSLATIONS',
    ask: '"Sim" se textos de interface foram adicionados/alterados e traduzidos em PT, EN e ES; "Não se aplica" se não houve texto',
    kind: 'check',
  },
];
const cfg = {
  id: 'svc',
  pullRequest: {
    template: resolve(__dirname, 'fixtures', 'golden', 'pr-template.md'),
    branchUrl: 'https://env/{key_lower}',
  },
} as never;
const facts = (message: string, sections: PrSection[]) => ({
  key: 'PF-1',
  title: 'Título',
  url: 'https://card/PF-1',
  branch: 'pf-1-x',
  body: 'Corpo do card',
  changedFiles: ['src/a.php', 'tests/aTest.php', 'database/migrations/2026_x.php'],
  testsPassed: true,
  testCommand: ['npm', 'test'],
  sections: parsePrSections(message, sections),
});
const FULL =
  'texto\n<pr>\n<problema>P1</problema>\n<solucao>S1</solucao>\n<como_testar>T1</como_testar>\n<banco>UPDATE x</banco>\n<traducoes>Sim, PT EN ES</traducoes>\n</pr>';
const PARTIAL = '<pr><problema>P2</problema><traducoes>Não se aplica</traducoes></pr>';

test("with the company's five sections, the <pr> request is the same text it was", async () => {
  expect(await prSectionsRequest(COMPANY)).toBe(await golden('pr-sections-request.txt'));
});

test("with the company's five sections, the PR description is the same as before", async () => {
  for (const [message, file] of [
    [FULL, 'pr-full.txt'],
    [PARTIAL, 'pr-partial.txt'],
    ['sem bloco', 'pr-none.txt'],
  ])
    expect(await renderPrTemplate(cfg, '/x/tenants.yaml', facts(message, COMPANY), COMPANY)).toBe(
      await golden(file),
    );
});

test('the core asks only for problem, solution and how to test', async () => {
  const request = await prSectionsRequest(DEFAULT_FORMATS.pullRequest.sections);
  expect(request).toContain('<como_testar>');
  expect(request).not.toContain('<banco>');
  expect(request).not.toContain('<traducoes>');
  const sections = DEFAULT_FORMATS.pullRequest.sections;
  const text = await renderPrTemplate(cfg, '/x/tenants.yaml', facts(FULL, sections), sections);
  expect(text).toContain('P: P1');
  // sections the core does not know stay as placeholders for the template's owner to see
  expect(text).toContain('D: {{DATABASE}}');
  expect(text).toContain('TR: {{TRANSLATIONS}}');
});

test('a configured section is asked, read and filled', async () => {
  const sections: PrSection[] = [
    {
      tag: 'riscos',
      placeholder: 'RISKS',
      ask: 'riscos da mudança',
      fallback: 'Nenhum',
      kind: 'text',
    },
  ];
  expect(
    await withProjectRules(
      'P',
      { pullRequest: { template: 't.md' } } as never,
      undefined,
      sections,
    ),
  ).toContain('<riscos>riscos da mudança</riscos>');
  expect(parsePrSections('<pr><riscos>cache</riscos></pr>', sections)).toEqual({ riscos: 'cache' });
});
