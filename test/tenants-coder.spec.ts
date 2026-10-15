import { loadTenants, tenantSecrets, useTenants } from '../src/tenants/tenants';
import { createHost } from '../src/tenants/tenant-registry.service';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';
test('a coder project in rehearsal loads with defaults', () => {
  const [t] = loadTenants(yaml());
  const p = t.projects[0];
  expect(p.workspace).toEqual({
    type: 'coder',
    url: 'https://coder.example.com',
    name: 'dev-ws',
    root: '/root/ai-dev-team',
    reference: '/workspaces/shop-orders',
    protect: ['/workspaces'],
  });
  expect(p.delivery).toBe('rehearsal');
  const host = createHost(t.hosts[0]);
  expect(host.cloneUrl('shop/x')).toBe('ssh://git.example.com:2244/shop/x.git');
  expect(host.gitAuthHeader()).toBe('');
});
test('existing projects default to local + normal', () => {
  const [t] = loadTenants(yaml(''));
  expect(t.projects[0].workspace).toEqual({ type: 'local' });
  expect(t.projects[0].delivery).toBe('normal');
});
test.each([
  [
    'a runner',
    `${CODER_PROJECT}\n        runner: { type: docker, image: php, workdir: /app }`,
    '',
    /runner/,
  ],
  [
    'root inside protect',
    CODER_PROJECT.replace('/root/ai-dev-team', '/workspaces/x'),
    '',
    /protect/,
  ],
  ['a relative root', CODER_PROJECT.replace('/root/ai-dev-team', 'tasks'), '', /absolute/],
  ['a root with ..', CODER_PROJECT.replace('/root/ai-dev-team', '/root/../workspaces'), '', /\.\./],
  ['a harness', CODER_PROJECT, '    harness: { path: /h }', /harness/],
])('coder refuses %s', (_name, project, extra, error) => {
  expect(() => loadTenants(yaml(project, extra))).toThrow(error);
});
test('coder refuses credentials other than claude without apiKey', () => {
  const codex = yaml()
    .replace('providers: [claude]', 'providers: [claude, codex]')
    .replace(
      '[{ id: corp, provider: claude }]',
      '[{ id: corp, provider: claude }, { id: gpt, provider: codex }]',
    );
  expect(() => loadTenants(codex)).toThrow(/gpt.*claude/);
  const key = yaml().replace(
    '{ id: corp, provider: claude }',
    '{ id: corp, provider: claude, apiKey: k }',
  );
  expect(() => loadTenants(key)).toThrow(/apiKey/);
});
test('gitlab host requires https baseUrl and an ssh sshUrl', () => {
  expect(() => loadTenants(yaml('').replace('ssh://git.example.com:2244', 'https://x'))).toThrow(
    /ssh/,
  );
  expect(() =>
    loadTenants(yaml('').replace('https://git.example.com', 'http://git.example.com')),
  ).toThrow(/https/);
});
test('the GitLab token is masked in logs', () => {
  useTenants(loadTenants(yaml()));
  try {
    expect(tenantSecrets()).toContain('glpat-123456');
  } finally {
    useTenants(undefined);
  }
});
test('coder publishes (draft / normal) through GitLab', () => {
  for (const delivery of ['draft', 'normal']) {
    const [t] = loadTenants(
      yaml(
        `${CODER_PROJECT.replace('rehearsal', delivery)}\n        pullRequest: { title: '{key} - {title}', reviewers: [pat.doe] }`,
      ),
    );
    expect(t.projects[0].delivery).toBe(delivery);
    expect(t.projects[0].pullRequest).toMatchObject({
      title: '{key} - {title}',
      reviewers: ['pat.doe'],
    });
  }
});
test('coder refuses a host other than GitLab (its token would reach the workspace)', () => {
  const github = yaml().replace(
    /- id: gl\n\s+type: gitlab[\s\S]*?token: glpat-123456/,
    '- { id: gl, type: github, token: ghp-x }',
  );
  expect(() => loadTenants(github)).toThrow(/gitlab/);
});
test('PR title and reviewers are validated', () => {
  const bad = (pr: string) => yaml(`${CODER_PROJECT}\n        pullRequest: ${pr}`);
  expect(() => loadTenants(bad("{ reviewers: ['a b'] }"))).toThrow(/reviewer/);
  expect(() => loadTenants(bad(`{ title: '${'x'.repeat(201)}' }`))).toThrow(/title/);
});
test('coder accepts security checks (they run in the workspace)', () => {
  const [t] = loadTenants(yaml(`${CODER_PROJECT}\n        checks: { tools: [gitleaks] }`));
  expect(t.projects[0].checks?.tools).toEqual(['gitleaks']);
});
