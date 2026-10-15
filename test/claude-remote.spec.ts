import { ClaudeProvider } from '../src/agents/claude.provider';
const HELP =
  '--print --output-format --permission-mode --setting-sources --strict-mcp-config --add-dir --disallowed-tools --effort --no-session-persistence';
type Answer = { success: boolean; exitCode: number; stdout: string; stderr: string };
const ok = (stdout = ''): Answer => ({ success: true, exitCode: 0, stdout, stderr: '' });
function remote(
  script: { snapshot?: (n: number) => string; login?: Answer; state?: () => string } = {},
) {
  let snapshots = 0;
  const ws: any = {
    kind: 'coder',
    label: 'ws:/root/ai/t',
    attachmentsPath: '/root/ai/t/.ai-dev-team/attachments',
    cfg: { name: 'ws', protect: ['/workspaces'] },
    upload: jest.fn(),
    protectSnapshot: jest.fn(async () => script.snapshot?.(++snapshots) ?? 'same\n'),
    run: jest.fn(async (argv: string[]) => {
      if (argv[0] === 'claude' && argv[1] === '--help') return ok(HELP);
      if (argv[0] === 'claude') return ok(JSON.stringify({ result: 'Feito.' }));
      if (argv.join(' ').includes('.credentials.json')) return script.login ?? ok();
      if (argv.join(' ').includes('rev-parse')) return ok(script.state?.() ?? 'head\nhash');
      return ok();
    }),
  };
  const local = { run: jest.fn() };
  const provider = new ClaudeProvider(local as any, local as any);
  const input: any = {
    taskId: 't',
    tenantId: 'initech',
    credentialId: 'corp',
    prompt: 'faça',
    workspace: '/tmp/x',
    timeoutMs: 1000,
    remote: ws,
  };
  const claudeCall = () =>
    ws.run.mock.calls.find((c: any[]) => c[0][0] === 'claude' && c[0][1] !== '--help');
  return { provider, input, ws, local, claudeCall };
}
test('runs claude in the workspace with the usual flags and the prompt on stdin', async () => {
  const { provider, input, local, claudeCall } = remote();
  const r = await provider.execute(input);
  expect(r).toMatchObject({ success: true, message: 'Feito.' });
  const [argv, opts] = claudeCall();
  expect(argv).toEqual(
    expect.arrayContaining([
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      'user,project',
      '--strict-mcp-config',
    ]),
  );
  expect(opts).toMatchObject({ input: 'faça', provider: 'claude', agent: 'coder' });
  // nothing runs on this machine: no local claude, no bubblewrap
  expect(local.run).not.toHaveBeenCalled();
});
test('attachments are uploaded into the task folder and added with --add-dir', async () => {
  const { provider, input, ws, claudeCall } = remote();
  await provider.execute({ ...input, attachments: { dir: '/tmp/att', files: [] } });
  expect(ws.upload).toHaveBeenCalledWith('/tmp/att', '.ai-dev-team/attachments');
  const argv: string[] = claudeCall()[0];
  expect(argv[argv.indexOf('--add-dir') + 1]).toBe(ws.attachmentsPath);
});
test('no Claude login in the workspace: an operator decision, not a capacity wait', async () => {
  const { provider, input, claudeCall } = remote({
    login: { ...ok(), success: false, exitCode: 1 },
  });
  await expect(provider.execute(input)).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/login/),
  });
  expect(claudeCall()).toBeUndefined();
});
test('protected repositories changed during the run: the task fails naming them (focus 1)', async () => {
  const { provider, input } = remote({
    snapshot: (n) => (n === 1 ? '/workspaces/a h b s1\n' : '/workspaces/a h b s2\n'),
  });
  await expect(provider.execute(input)).rejects.toThrow(/\/workspaces\/a.*VS Code/s);
});
test('a read-only run (reviewer) that changes the task folder fails', async () => {
  let n = 0;
  const { provider, input } = remote({ state: () => `head\nhash-${++n}` });
  await expect(provider.execute({ ...input, readOnly: true, role: 'reviewer' })).rejects.toThrow(
    /somente leitura/,
  );
});
test('a read-only run that changes nothing passes', async () => {
  const { provider, input } = remote();
  await expect(provider.execute({ ...input, readOnly: true })).resolves.toMatchObject({
    success: true,
  });
});
test('in the workspace the repository harness counts: project settings, skills and plugins', async () => {
  const { provider, input, claudeCall } = remote();
  await provider.execute(input);
  const argv: string[] = claudeCall()[0];
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,project');
  expect(argv).toContain('--strict-mcp-config');
});
test('the git identity reaches the remote run (the agent of a method commits)', async () => {
  const { provider, input, claudeCall } = remote();
  await provider.execute({ ...input, env: { GIT_AUTHOR_NAME: 'AI', GIT_AUTHOR_EMAIL: 'a@b' } });
  expect(claudeCall()[1].env).toEqual({ GIT_AUTHOR_NAME: 'AI', GIT_AUTHOR_EMAIL: 'a@b' });
});
