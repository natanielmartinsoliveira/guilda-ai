import { ensurePlugins, olderThan, pluginProblems } from '../src/agents/claude-plugins';
import { loadTenants } from '../src/tenants/tenants';
import { failureKind } from '../src/tasks/failure-kind';
const METHOD = { id: 'method@acme-market', marketplace: 'acme/method', minVersion: '5.20.0' };
const RULES = { id: 'rules@rules-market', marketplace: 'https://git.example.com/rules.git' };
/** A workspace whose `claude plugin` commands change what `list --json` answers. */
function workspace(installed: { id: string; version?: string; enabled?: boolean }[], name = 'ws') {
  const state = installed.map((p) => ({ ...p }));
  const commands: string[] = [];
  const run = jest.fn(async (argv: string[]) => {
    const line = argv.join(' ');
    if (line !== 'claude plugin list --json') commands.push(line);
    const [, , verb, id] = argv;
    if (verb === 'install' && id !== 'broken@x')
      state.push({ id, version: '9.0.0', enabled: true });
    if (verb === 'update') state.find((p) => p.id === id)!.version = '9.0.0';
    if (verb === 'enable') state.find((p) => p.id === id)!.enabled = true;
    return { success: true, stdout: JSON.stringify(state), stderr: '', exitCode: 0 };
  });
  return {
    ws: { cfg: { url: 'https://coder.example.com', name }, run } as never,
    run,
    commands,
  };
}
test('versions compare number by number', () => {
  expect(olderThan('5.9.1', '5.20.0')).toBe(true);
  expect(olderThan('5.20.0', '5.20.0')).toBe(false);
  expect(olderThan('5.20.1', '5.20')).toBe(false);
  expect(olderThan(undefined, '1.0.0')).toBe(true);
});
test('what is wrong: missing, older than the minimum, disabled', () => {
  expect(
    pluginProblems(
      [
        { id: METHOD.id, version: '5.9.0', enabled: true },
        { id: RULES.id, version: '1.0.0', enabled: false },
      ],
      [METHOD, RULES, { id: 'x@y', marketplace: 'a/b' }],
    ).map((p) => `${p.plugin.id} ${p.problem}`),
  ).toEqual(['method@acme-market old', 'rules@rules-market disabled', 'x@y missing']);
});
test('a missing plugin is installed from its marketplace, an old one updated, a disabled one enabled', async () => {
  const { ws, commands } = workspace([{ id: RULES.id, version: '1.0.0', enabled: false }], 'a');
  await ensurePlugins(ws, [METHOD, RULES], 't1', 1);
  expect(commands).toEqual([
    'claude plugin marketplace add acme/method',
    'claude plugin install method@acme-market',
    'claude plugin enable rules@rules-market',
  ]);
  const old = workspace([{ id: METHOD.id, version: '5.9.0', enabled: true }], 'b');
  await ensurePlugins(old.ws, [METHOD], 't1', 1);
  expect(old.commands).toEqual([
    'claude plugin marketplace update acme-market',
    'claude plugin update method@acme-market',
  ]);
});
test('checked once per half hour; nothing declared, nothing run', async () => {
  const { ws, run } = workspace([{ id: METHOD.id, version: '5.20.0', enabled: true }], 'c');
  await ensurePlugins(ws, [METHOD], 't1', 1000);
  await ensurePlugins(ws, [METHOD], 't2', 1000 + 60000);
  expect(run).toHaveBeenCalledTimes(2);
  await ensurePlugins(ws, [METHOD], 't3', 1000 + 31 * 60000);
  expect(run).toHaveBeenCalledTimes(4);
  const none = workspace([], 'd');
  await ensurePlugins(none.ws, [], 't1');
  expect(none.run).not.toHaveBeenCalled();
});
test('a plugin the workspace cannot get stops the task as configuration, saying what to run', async () => {
  const { ws } = workspace([], 'e');
  const failed = ensurePlugins(ws, [{ id: 'broken@x', marketplace: 'acme/broken' }], 't1');
  await expect(failed).rejects.toMatchObject({ retryable: false });
  await expect(failed).rejects.toThrow(
    'broken@x (não instalado). No terminal do workspace: claude plugin marketplace add acme/broken e claude plugin install broken@x',
  );
  const message = await failed.then(
    () => '',
    (e: Error) => e.message,
  );
  expect(failureKind(message)).toBe('config');
});
const tenants = (plugins: string) => `
tenants:
  - id: acme
    name: Acme
    git: { authorName: Bot, authorEmail: bot@acme.test }
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [{ id: gh, type: gitlab, baseUrl: https://git.example.com, sshUrl: ssh://git.example.com, token: t }]
    projects:
      - id: api
        host: gh
        repository: acme/api
        test: [npm, test]
        workspace: { type: coder, url: https://coder.example.com, name: ws, root: /root/ai, plugins: ${plugins} }
`;
test('the workspace declares its plugins; a marketplace that could run a command is refused', () => {
  const [t] = loadTenants(
    tenants(`[{ id: ${METHOD.id}, marketplace: acme/method, minVersion: 5.20.0 }]`),
    {},
  );
  expect(t.projects[0].workspace).toMatchObject({ plugins: [METHOD] });
  for (const bad of [
    '[{ id: method, marketplace: acme/method }]',
    `[{ id: ${METHOD.id}, marketplace: "acme/method; rm -rf ~" }]`,
    `[{ id: ${METHOD.id}, marketplace: "http://git.example.com/x.git" }]`,
  ])
    expect(() => loadTenants(tenants(bad), {})).toThrow();
});
