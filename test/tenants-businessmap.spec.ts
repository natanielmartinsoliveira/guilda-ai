import { loadTenants, tenantSecrets, useTenants } from '../src/tenants/tenants';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';

const TOKEN = 'b'.repeat(40);
const source = (extra = '') => `    sources:
      - id: businessmap
        type: businessmap
        baseUrl: https://initech.kanbanize.com/
        token: ${TOKEN}
        boardId: 79
        trigger: { columns: [3170], tag: ai-dev-team }
        repositoryField: 13
${extra}`;

afterEach(() => useTenants(undefined));

test('a businessmap source loads with defaults', () => {
  const [t] = loadTenants(yaml(CODER_PROJECT, source()));
  const s = t.sources[0];
  expect(s).toMatchObject({
    type: 'businessmap',
    baseUrl: 'https://initech.kanbanize.com',
    pollSeconds: 60,
    boardId: 79,
    trigger: { columns: [3170], tag: 'ai-dev-team' },
    repositoryField: 13,
  });
  // No route tags of any method by default: a tag named as a route is that route.
  expect((s as { routeTags: unknown }).routeTags).toEqual({});
});

test('the token is one of the secrets redacted from logs', () => {
  useTenants(loadTenants(yaml(CODER_PROJECT, source())));
  expect(tenantSecrets()).toContain(TOKEN);
});

test.each([
  [
    'no trigger',
    source().replace('{ columns: [3170], tag: ai-dev-team }', '{ columns: [] }'),
    /trigger/,
  ],
  ['http', source().replace('https://initech', 'http://initech'), /https/],
  ['poll under 30s', source('        pollSeconds: 10'), /pollSeconds/],
  [
    'a route name that is not a name',
    source('        routeTags: { x: "Not A Route" }'),
    /routeTags/,
  ],
])('refuses %s', (_, extra, error) => {
  expect(() => loadTenants(yaml(CODER_PROJECT, extra))).toThrow(error);
});

test('project evidence: a pinned Playwright version', () => {
  const [t] = loadTenants(yaml(`${CODER_PROJECT}\n        evidence: { playwright: 1.48.2 }`));
  expect(t.projects[0].evidence).toEqual({ playwright: '1.48.2', timeoutMinutes: 30 });
  expect(() =>
    loadTenants(yaml(`${CODER_PROJECT}\n        evidence: { playwright: latest }`)),
  ).toThrow(/version/);
});

test('evidence needs a Coder workspace (prints are taken there)', () => {
  expect(() => loadTenants(yaml('        evidence: { playwright: 1.48.2 }'))).toThrow(
    /evidence needs a coder workspace/,
  );
});

test('route tags written with case and accents still match', () => {
  const [t] = loadTenants(
    yaml(CODER_PROJECT, source('        routeTags: { "Correção": corrective, " Tela ": surface }')),
  );
  expect((t.sources[0] as { routeTags: unknown }).routeTags).toEqual({
    correcao: 'corrective',
    tela: 'surface',
  });
});

test('the trigger may name the card owners; moves name the column of each step', () => {
  const [t] = loadTenants(
    yaml(
      CODER_PROJECT,
      source('        moves: { gate: 11, building: 12, built: 13, review: 14 }').replace(
        '{ columns: [3170], tag: ai-dev-team }',
        '{ columns: [3168], owners: [7] }',
      ),
    ),
  );
  expect(t.sources[0]).toMatchObject({
    trigger: { columns: [3168], owners: [7] },
    moves: { gate: 11, building: 12, built: 13, review: 14 },
  });
  const [d] = loadTenants(yaml(CODER_PROJECT, source()));
  expect(d.sources[0]).toMatchObject({ trigger: { owners: [] }, moves: {} });
  expect(() => loadTenants(yaml(CODER_PROJECT, source('        moves: { other: 1 }')))).toThrow(
    /moves/,
  );
  expect(() => loadTenants(yaml(CODER_PROJECT, source('        moves: { gate: 0 }')))).toThrow(
    /moves/,
  );
});
