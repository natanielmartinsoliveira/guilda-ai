import { SandboxService } from '../src/agents/sandbox.service';
test('worker sandbox refuses root before any subprocess', async () => {
  const uid = jest.spyOn(process, 'getuid').mockReturnValue(0),
    runner = { run: jest.fn() };
  try {
    await expect(
      new SandboxService(runner as any).run('node', [], {
        cwd: '/tmp',
        taskId: 'task',
        tenantId: 'acme',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('non-root');
    expect(runner.run).not.toHaveBeenCalled();
  } finally {
    uid.mockRestore();
  }
});
test('never mounts attachments from another tenant', async () => {
  const { mkdir, rm } = await import('node:fs/promises');
  const { workspace, config } = await import('../src/config');
  const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0',
    cwd = workspace('acme', id),
    other = `${config().ATTACHMENTS_ROOT}/globex/api/x`,
    runner = { run: jest.fn() };
  await mkdir(cwd, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(`${config().ATTACHMENTS_ROOT}/acme`, { recursive: true });
  try {
    await expect(
      new SandboxService(runner as any).run('node', [], {
        cwd,
        taskId: id,
        tenantId: 'acme',
        timeoutMs: 1000,
        attachmentsDir: other,
      }),
    ).rejects.toThrow('Attachments path is not isolated');
    expect(runner.run).not.toHaveBeenCalled();
  } finally {
    await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
    await rm(config().ATTACHMENTS_ROOT, { recursive: true, force: true });
  }
});
test('read-only runs mount the workspace read-only; a custom key variable carries the key', async () => {
  const { mkdir, rm } = await import('node:fs/promises');
  const { workspace, config } = await import('../src/config');
  const id = '46c96583-9ca3-4f12-9d76-0588b0352ae1',
    cwd = workspace('acme', id),
    runner = { run: jest.fn().mockResolvedValue({ success: true }) };
  await mkdir(cwd, { recursive: true });
  try {
    const sandbox = new SandboxService(runner as any);
    const opts = { cwd, taskId: id, tenantId: 'acme', timeoutMs: 1000, credentialId: 'router' };
    await sandbox.run(
      'codex',
      [],
      { ...opts, readOnly: true, apiKey: 'k', apiKeyEnv: 'OPENROUTER_API_KEY' },
      true,
      'codex',
    );
    const [, args, run] = runner.run.mock.calls[0];
    const at = args.indexOf('/workspace');
    expect(args.slice(at - 2, at + 1)).toEqual(['--ro-bind', cwd, '/workspace']);
    expect(run.env).toEqual({ OPENROUTER_API_KEY: 'k' });
    await sandbox.run('codex', [], { ...opts, apiKey: 'k' }, true, 'codex');
    const [, writable, plain] = runner.run.mock.calls[1];
    const w = writable.indexOf('/workspace');
    expect(writable[w - 2]).toBe('--bind');
    expect(plain.env).toEqual({ OPENAI_API_KEY: 'k' });
    await expect(
      sandbox.run('codex', [], { ...opts, apiKey: 'k', apiKeyEnv: 'PATH' }, true, 'codex'),
    ).rejects.toThrow('Invalid API key variable');
  } finally {
    await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
  }
});
describe('refreshed CLI credentials are saved back', () => {
  const id = '56c96583-9ca3-4f12-9d76-0588b0352ae2';
  const original = JSON.stringify({ claudeAiOauth: { refreshToken: 'r0' } });
  let cwd: string, auth: string, home: string;
  beforeEach(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { workspace, config } = await import('../src/config');
    cwd = workspace('acme', id);
    home = `${config().AGENT_HOME}/acme/claude-max`;
    auth = `${home}/.credentials.json`;
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(auth, original, { mode: 0o600 });
  });
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    const { config } = await import('../src/config');
    await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
    await rm(config().AGENT_HOME, { recursive: true, force: true });
  });
  /** Runner that plays the sandbox: the CLI leaves `written` in the writable outbox. */
  const runnerWriting = (written?: string, fail = false) => ({
    run: jest.fn(async (_bin: string, args: string[]) => {
      const { writeFile } = await import('node:fs/promises');
      const at = args.indexOf('/credentials-out');
      if (at > 0 && written !== undefined) {
        expect(args[at - 2]).toBe('--bind');
        await writeFile(`${args[at - 1]}/.credentials.json`, written);
      }
      if (fail) throw new Error('timeout');
      return { success: true };
    }),
  });
  const run = (runner: { run: jest.Mock }) =>
    new SandboxService(runner as any).run(
      'claude',
      [],
      { cwd, taskId: id, tenantId: 'acme', timeoutMs: 1000, credentialId: 'claude-max' },
      true,
      'claude',
    );
  const leftovers = async () =>
    (await (await import('node:fs/promises')).readdir(home)).filter(
      (f) => f !== '.credentials.json',
    );

  test('a renewed login replaces the stored one, private to the owner', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    const renewed = JSON.stringify({ claudeAiOauth: { refreshToken: 'r1' } });
    await run(runnerWriting(renewed));
    expect(await readFile(auth, 'utf8')).toBe(renewed);
    expect((await stat(auth)).mode & 0o777).toBe(0o600);
    expect(await leftovers()).toEqual([]);
  });
  test('an untouched login is not rewritten', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    const before = (await stat(auth)).mtimeMs;
    await run(runnerWriting(original));
    expect(await readFile(auth, 'utf8')).toBe(original);
    expect((await stat(auth)).mtimeMs).toBe(before);
  });
  test('garbage from the sandbox never overwrites the login', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const junk of ['not json', '[]', 'null', '"x"']) {
      await run(runnerWriting(junk));
      expect(await readFile(auth, 'utf8')).toBe(original);
    }
    expect(await leftovers()).toEqual([]);
  });
  test('a failed run still saves the renewal and cleans the outbox', async () => {
    const { readFile } = await import('node:fs/promises');
    const renewed = JSON.stringify({ claudeAiOauth: { refreshToken: 'r2' } });
    await expect(run(runnerWriting(renewed, true))).rejects.toThrow('timeout');
    expect(await readFile(auth, 'utf8')).toBe(renewed);
    expect(await leftovers()).toEqual([]);
  });
  test('a run with an API key never replaces the stored login', async () => {
    const { readFile } = await import('node:fs/promises');
    const runner = runnerWriting(JSON.stringify({ OPENAI_API_KEY: 'k' }));
    await new SandboxService(runner as any).run(
      'claude',
      [],
      {
        cwd,
        taskId: id,
        tenantId: 'acme',
        timeoutMs: 1000,
        credentialId: 'claude-max',
        apiKey: 'k',
      },
      true,
      'claude',
    );
    expect(runner.run.mock.calls[0][1]).not.toContain('/credentials-out');
    expect(await readFile(auth, 'utf8')).toBe(original);
  });
  test('without a stored login (API key), nothing is saved', async () => {
    const { rm, readdir } = await import('node:fs/promises');
    await rm(auth);
    await run(runnerWriting(JSON.stringify({ OPENAI_API_KEY: 'k' })));
    expect(await readdir(home)).toEqual([]);
  });
});
