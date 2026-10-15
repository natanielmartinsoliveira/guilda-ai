import { DEFAULT_FORMATS, formatsFor } from '../src/formats/formats';
import { loadTenants } from '../src/tenants/tenants';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';

const COMPANY = `    formats:
      card: { frontTitles: [tela] }
      pullRequest:
        sections:
          - { tag: problema, placeholder: PROBLEM, ask: o problema, fallback: card }
          - { tag: banco, placeholder: DATABASE, ask: script do banco, fallback: Não }
      evidence: { timezone: America/Sao_Paulo }`;

test('without formats, the core defaults', () => {
  const [t] = loadTenants(yaml());
  const f = formatsFor(t, t.projects[0]);
  expect(f).toEqual(DEFAULT_FORMATS);
  expect(f.pullRequest.sections.map((s) => s.tag)).toEqual(['problema', 'solucao', 'como_testar']);
  expect(f.evidence.timezone).toBe('UTC');
  expect(f.card.frontTitles).toContain('front-end');
});

test('the company overrides field by field; lists are replaced, not merged', () => {
  const [t] = loadTenants(yaml(CODER_PROJECT, COMPANY));
  const f = formatsFor(t, t.projects[0]);
  expect(f.card.frontTitles).toEqual(['tela']);
  expect(f.card.endTitles).toEqual(DEFAULT_FORMATS.card.endTitles);
  expect(f.pullRequest.sections.map((s) => s.tag)).toEqual(['problema', 'banco']);
  expect(f.evidence).toEqual({ ...DEFAULT_FORMATS.evidence, timezone: 'America/Sao_Paulo' });
});

test('a project overrides its company the same way (Review Focus 1)', () => {
  const project = `${CODER_PROJECT}
        formats:
          pullRequest:
            sections: [{ tag: solucao, placeholder: SOLUTION, ask: o que foi feito }]`;
  const [t] = loadTenants(yaml(project, COMPANY));
  const f = formatsFor(t, t.projects[0]);
  expect(f.pullRequest.sections.map((s) => s.tag)).toEqual(['solucao']);
  expect(f.card.frontTitles).toEqual(['tela']);
});

test.each([
  [
    'an unknown timezone (Review Focus 4)',
    '      evidence: { timezone: America/Nowhere }',
    /timezone/,
  ],
  [
    'a tag that is not a lowercase word',
    '      pullRequest: { sections: [{ tag: Banco, placeholder: DATABASE, ask: x }] }',
    /tag/,
  ],
  [
    'a placeholder that is not upper case',
    '      pullRequest: { sections: [{ tag: banco, placeholder: database, ask: x }] }',
    /placeholder/,
  ],
  [
    'a section kind other than text or check',
    '      pullRequest: { sections: [{ tag: banco, placeholder: DATABASE, ask: x, kind: list }] }',
    /kind/,
  ],
])('refuses %s', (_, body, error) => {
  expect(() => loadTenants(yaml(CODER_PROJECT, `    formats:\n${body}`))).toThrow(error);
});

describe('review fixes', () => {
  test.each([
    [
      'a placeholder with digits (never filled)',
      '      pullRequest: { sections: [{ tag: passo, placeholder: STEP2, ask: x }] }',
      /placeholder/,
    ],
    [
      'a placeholder the system fills (KEY)',
      '      pullRequest: { sections: [{ tag: chave, placeholder: KEY, ask: x }] }',
      /reserved|reservado/,
    ],
    ['a blank card word (would match every section)', "      card: { nothing: ['  '] }", /card/],
    [
      'an evidence comment without a company pack',
      '      evidence: { comment: formats/evidence.md }',
      /packDir|pacote/,
    ],
  ])('refuses %s', (_, body, error) => {
    expect(() => loadTenants(yaml(CODER_PROJECT, `    formats:\n${body}`))).toThrow(error);
  });
  test('an evidence comment must exist inside the pack', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const pack = await mkdtemp(join(tmpdir(), 'ev-pack-'));
    const with_ = (comment: string) =>
      yaml(
        CODER_PROJECT,
        `    packDir: ${pack}\n    formats:\n      evidence: { comment: ${comment} }`,
      );
    expect(() => loadTenants(with_('formats/evidence.md'))).toThrow(/evidence\.md/);
    expect(() => loadTenants(with_('../fora.md'))).toThrow(/pacote/);
    await mkdir(join(pack, 'formats'));
    await writeFile(join(pack, 'formats', 'evidence.md'), '{{SHOTS}}');
    expect(() => loadTenants(with_('formats/evidence.md'))).not.toThrow();
  });
});
