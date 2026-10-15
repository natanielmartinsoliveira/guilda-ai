import { loadTenants, tenantSecrets } from '../src/tenants/tenants';
import { redact } from '../src/config';
const valid = `
tenants:
  - id: initrode
    name: Initrode
    git: { authorName: Bot, authorEmail: bot@initrode.test }
    ai:
      providers: [claude, codex]
      credentials:
        - { id: anthropic, provider: claude, apiKey: '\${INITRODE_KEY}' }
        - { id: chatgpt, provider: codex, model: gpt-5-codex }
    hosts: [{ id: gh, type: github, token: 'tok-\${INITRODE_TOKEN}' }]
    projects: [{ id: api, host: gh, repository: initrode/api, test: [npm, test] }]
`;
const env = { INITRODE_KEY: 'key-1', INITRODE_TOKEN: 'abc' };
test('interpolates secrets from env and applies defaults', () => {
  const [t] = loadTenants(valid, env);
  expect(t.ai.credentials[0].apiKey).toBe('key-1');
  expect(t.ai.credentials[1].model).toBe('gpt-5-codex');
  expect(t.ai.credentials[1].apiKey).toBeUndefined();
  expect(t.ai.credentials[1].cooldown).toEqual({
    quotaMinutes: 360,
    rateLimitMinutes: 5,
    authMinutes: 1440,
  });
  expect(t.hosts[0].token).toBe('tok-abc');
  expect(t.projects[0]).toMatchObject({ defaultBranch: 'main', prepare: [] });
  expect(t.sources).toEqual([]);
});
test('names the path of an unset secret instead of starting with an empty credential', () => {
  expect(() => loadTenants(valid, { INITRODE_KEY: 'key-1' })).toThrow(
    'tenants[0].hosts[0].token references unset variable INITRODE_TOKEN',
  );
});
test('rejects a credential of a provider the contract does not allow', () => {
  expect(() =>
    loadTenants(valid.replace('providers: [claude, codex]', 'providers: [claude]'), env),
  ).toThrow('credential "chatgpt" uses provider "codex", not in ai.providers');
});
test('rejects duplicate credential ids, which would share a login directory', () => {
  expect(() => loadTenants(valid.replace('id: chatgpt', 'id: anthropic'), env)).toThrow(
    'duplicate credential id "anthropic"',
  );
});
test('rejects a project pointing to an undeclared host', () => {
  expect(() => loadTenants(valid.replace('host: gh', 'host: bitbucket'), env)).toThrow(
    'references unknown host "bitbucket"',
  );
});
test('rejects duplicate tenant ids', () => {
  const twice = valid + valid.split('\n').slice(2).join('\n');
  expect(() => loadTenants(twice, env)).toThrow('duplicate tenant id "initrode"');
});
test('rejects unsafe tenant ids that would reach filesystem paths', () => {
  expect(() => loadTenants(valid.replace('id: initrode', 'id: ../etc'), env)).toThrow(
    'lowercase letters',
  );
});
test('redacts every tenant secret, not only the current one', () => {
  expect(tenantSecrets()).toEqual(
    expect.arrayContaining(['test-acme-openai-key', 'test-globex-github-token']),
  );
  expect(redact('a=test-acme-openai-key b=test-globex-webhook-secret-32-ch')).toBe(
    'a=[REDACTED] b=[REDACTED]',
  );
});
test('redacts well-known token shapes of other platforms', () => {
  for (const token of [
    'glpat-abcdefghijklmnopqrstuvwx',
    'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz',
    `ntn_${'a'.repeat(46)}`,
  ])
    expect(redact(`token ${token}`)).toBe('token [REDACTED]');
  expect(redact('ai/task-36c96583-9ca3-4f12-9d76-0588b0352ae0')).not.toContain('REDACTED');
});
test('empty variables in .env count as unset, as in .env.example', async () => {
  const { spawnSync } = await import('node:child_process');
  // Fresh process: config() caches the first parse.
  const r = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      'console.log(JSON.stringify(require("./src/config").config()))',
    ],
    {
      cwd: `${__dirname}/..`,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_PASSWORD: 'x',
        RABBITMQ_URL: 'amqp://x',
        API_TOKEN: '',
        SOURCE_POLLING: '',
        MAX_ATTEMPTS: '',
      },
    },
  );
  expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toMatchObject({ SOURCE_POLLING: true, MAX_ATTEMPTS: 3 });
  expect(JSON.parse(r.stdout).API_TOKEN).toBeUndefined();
});
