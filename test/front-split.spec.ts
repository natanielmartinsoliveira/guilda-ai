import { frontSection } from '../src/tasks/front-split';
const card = (middle: string) =>
  `Objetivo\n\nPermitir recusar.\n\nCritérios de aceite\n\nBack-end\n\n1. Endpoint novo.\n\n${middle}\n\nCenários de teste\n\nCenário 1: recusa\n\nDefinições técnicas\n\nArquivo: src/x.php`;
test('a Front-end title on its own line, up to the next top-level section', () => {
  expect(frontSection(card('Front-end\n\n1. Toggle novo na tela.\n2. Salvar junto.'))).toBe(
    'Front-end\n\n1. Toggle novo na tela.\n2. Salvar junto.',
  );
});
test('a Front-end title with a path, as a list item or a markdown heading', () => {
  expect(frontSection(card('Front-end (src/public/vue-base/a.vue)\n\n- Tag nova.'))).toBe(
    'Front-end (src/public/vue-base/a.vue)\n\n- Tag nova.',
  );
  expect(frontSection(card('- Front-end (perf/stakeholders.html)\n  - Botão Reprovar.'))).toBe(
    '- Front-end (perf/stakeholders.html)\n  - Botão Reprovar.',
  );
  expect(frontSection(card('## Front-end\n\nModal de confirmação.'))).toBe(
    '## Front-end\n\nModal de confirmação.',
  );
});
test('"back-end" or "front-end" inside a sentence neither starts nor ends a section', () => {
  const body = card(
    'Front-end (a.vue)\n\nRisco de regressão (mesmo motivo do back-end, mas no template).\nVer o front-end antigo.',
  );
  expect(frontSection(body)).toBe(
    'Front-end (a.vue)\n\nRisco de regressão (mesmo motivo do back-end, mas no template).\nVer o front-end antigo.',
  );
});
test('no Front-end section, or an empty title, means no front work', () => {
  expect(frontSection(card(''))).toBeUndefined();
  expect(frontSection(card('Front-end'))).toBeUndefined();
  expect(frontSection('Ajustar o texto do botão.')).toBeUndefined();
});
test('a section at the end of the card goes to the end', () => {
  expect(frontSection('Back-end\n\n1. x\n\nFront-end\n\nTela nova.')).toBe(
    'Front-end\n\nTela nova.',
  );
});
test('a Front-end section saying there is nothing to do is no front work (review I4)', () => {
  expect(frontSection(card('- Front-end: não se aplica'))).toBeUndefined();
  expect(frontSection(card('Front-end\n\nN/A'))).toBeUndefined();
  expect(frontSection(card('Front-end\n\nSem alteração de tela.'))).toBeUndefined();
  expect(frontSection(card('Front-end\n\nNenhuma mudança.'))).toBeUndefined();
});

describe('configured card sections', () => {
  const card = {
    frontTitles: ['tela', 'interface'],
    endTitles: ['critérios de aceite', 'regras de negócio'],
    nothing: ['sem tela'],
  };
  test('a configured title opens the section, with any case, accents or markup (Review Focus 3)', () => {
    expect(
      frontSection('Contexto\n\n**TELA:** novo botão\n- Salvar\n\nCriterios de Aceite\n- ok', card),
    ).toBe('**TELA:** novo botão\n- Salvar');
    expect(frontSection('## Interface\n\nModal.\n\n## Regras de negócio\nx', card)).toBe(
      '## Interface\n\nModal.',
    );
  });
  test('the default titles do not apply once a company configures its own', () => {
    expect(frontSection('Front-end\n\nBotão.', card)).toBeUndefined();
  });
  test('a configured "nothing" phrase means no screen work', () => {
    expect(frontSection('Tela: sem tela nesta entrega', card)).toBeUndefined();
  });
});
