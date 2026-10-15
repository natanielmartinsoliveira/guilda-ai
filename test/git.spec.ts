import { GitService } from '../src/git/git.service';
import { Task } from '../src/database/entities';
const task = {
  id: '36c96583-9ca3-4f12-9d76-0588b0352ae0',
  tenantId: 'acme',
  workspace: '/tmp/work',
  branch: 'ai/task-36c96583-9ca3-4f12-9d76-0588b0352ae0',
} as Task;
const remote = {
  url: 'https://github.com/example/demo.git',
  authHeader: 'Authorization: Basic c2VjcmV0',
};
const author = { name: 'Acme Bot', email: 'bot@acme.test' };
function setup() {
  const runner = {
    run: jest
      .fn()
      .mockResolvedValue({ success: true, stdout: task.branch, stderr: '', exitCode: 0 }),
  };
  return { runner, git: new GitService(runner as any) };
}
test('generates fixed commit message with tenant identity and never uses a shell', async () => {
  const { git, runner } = setup();
  await git.commit(task, 'feat(ai): implement API-123', author);
  const commit = runner.run.mock.calls.find((c) => c[1].includes('commit'));
  expect(commit[1].slice(-3)).toEqual(['commit', '-m', 'feat(ai): implement API-123']);
  expect(commit[2].env).toMatchObject({
    GIT_AUTHOR_NAME: 'Acme Bot',
    GIT_COMMITTER_EMAIL: 'bot@acme.test',
  });
});
test('rejects main and changed branches', async () => {
  const { git } = setup();
  await expect(git.assertBranch({ ...task, branch: 'main' })).rejects.toThrow('Protected branch');
});
test('push uses immutable sha, explicit destination and header only in env', async () => {
  const { git, runner } = setup();
  await git.push(task, 'a'.repeat(40), remote);
  const [, args, opts] = runner.run.mock.calls[1];
  expect(args).toContain(`${'a'.repeat(40)}:refs/heads/${task.branch}`);
  expect(args).toContain(remote.url);
  expect(args).not.toContain('--force');
  expect(args.join(' ')).not.toContain('c2VjcmV0');
  expect(opts.env).toMatchObject({
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: remote.authHeader,
  });
});
test('local commands never receive credentials', async () => {
  const { git, runner } = setup();
  await git.git(task, ['status']);
  expect(runner.run.mock.calls[0][2].env.GIT_CONFIG_VALUE_0).toBeUndefined();
});
test('fails on no changes', async () => {
  const { git, runner } = setup();
  runner.run
    .mockResolvedValueOnce({ success: true, stdout: task.branch })
    .mockResolvedValue({ success: true, stdout: '' });
  await expect(git.validateChanges(task)).rejects.toThrow('NO_CHANGES');
});
test('blocks secret modifications', async () => {
  const { git, runner } = setup();
  runner.run
    .mockResolvedValueOnce({ success: true, stdout: task.branch })
    .mockResolvedValueOnce({ success: true, stdout: '.env\0' })
    .mockResolvedValueOnce({ success: true, stdout: '' });
  await expect(git.validateChanges(task)).rejects.toThrow('Protected file');
});
test('refuses a workspace outside the tenant directory', async () => {
  const { git } = setup();
  await expect(git.prepare(task, 'main', remote)).rejects.toThrow('Unsafe workspace');
});
test('credential guard judges PEM files by content and env files by name', async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname } = await import('node:path');
  const { findCredentialFiles } = await import('../src/git/git.service');
  const root = await mkdtemp(`${tmpdir()}/creds-`);
  const put = async (file: string, content: string) => {
    await mkdir(dirname(`${root}/${file}`), { recursive: true });
    await writeFile(`${root}/${file}`, content);
  };
  await put('certificates/ca.pem', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
  await put('deploy/server.key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
  await put('keys/bundle.pem', 'x\n-----BEGIN CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\n');
  try {
    const files = [
      'certificates/ca.pem',
      'deploy/server.key',
      'keys/bundle.pem',
      '.env.example',
      'services/x/.env.example',
      'api/.env.sample',
      '.env',
      'api/.env.production',
      'lib/pika/credentials.py',
      'lib/__pycache__/credentials.cpython-312.pyc',
      'config/credentials.json',
      'ops/id_ed25519',
      'ops/id_ed25519.pub',
      'android/release.jks',
    ];
    expect(await findCredentialFiles(root, files)).toEqual([
      'deploy/server.key',
      'keys/bundle.pem',
      '.env',
      'api/.env.production',
      'config/credentials.json',
      'ops/id_ed25519',
      'android/release.jks',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('network failures are retryable, server refusals are not', async () => {
  const { git, runner } = setup();
  const failPush = (stderr: string) =>
    runner.run
      .mockResolvedValueOnce({ success: true, stdout: task.branch })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr, exitCode: 1 });
  failPush('fatal: unable to access: Could not resolve host: github.com');
  await expect(git.push(task, 'a'.repeat(40), remote)).rejects.toMatchObject({ retryable: true });
  failPush(
    'remote: error: GH007: Your push would publish a private email address.\n ! [remote rejected] x -> y (push declined due to email privacy restrictions)',
  );
  await expect(git.push(task, 'a'.repeat(40), remote)).rejects.toMatchObject({ retryable: false });
  failPush(' ! [rejected] x -> y (non-fast-forward)');
  await expect(git.push(task, 'a'.repeat(40), remote)).rejects.toMatchObject({ retryable: false });
});
test('prepare moves an existing workspace back to the base tip when asked', async () => {
  const { mkdir, rm } = await import('node:fs/promises');
  const { workspace, config } = await import('../src/config');
  const ws = workspace('acme', task.id);
  await mkdir(ws, { recursive: true });
  const { git, runner } = setup();
  try {
    await git.prepare({ ...task, workspace: ws }, 'main', remote, { resetToBase: true });
    const commands = runner.run.mock.calls.map((c) => c[1].slice(8).join(' '));
    expect(commands).toEqual(
      expect.arrayContaining([
        `fetch --no-tags ${remote.url} refs/heads/main`,
        'reset --hard',
        `checkout -B ${task.branch} FETCH_HEAD`,
        'clean -fd',
      ]),
    );
    expect(commands.indexOf('reset --hard')).toBeLessThan(
      commands.indexOf(`checkout -B ${task.branch} FETCH_HEAD`),
    );
    runner.run.mockClear();
    await git.prepare({ ...task, workspace: ws }, 'main', remote);
    expect(runner.run.mock.calls.map((c) => c[1][8])).not.toContain('fetch');
  } finally {
    await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
  }
});
describe('workspace preparation survives a slow or interrupted clone', () => {
  const { mkdir, writeFile, rm } = jest.requireActual('node:fs/promises');
  const { existsSync } = jest.requireActual('node:fs');
  const { join } = jest.requireActual('node:path');
  const { workspace } = jest.requireActual('../src/config');
  const real = () => ({ ...task, workspace: workspace('acme', task.id) as string });
  function fake(cloneOk = true) {
    const runner = {
      run: jest.fn(
        async (
          _cmd: string,
          args: string[],
          opts?: { timeoutMs?: number; maxOutputBytes?: number; cwd?: string },
        ) => {
          const ok = { success: true, stdout: '', stderr: '', exitCode: 0 };
          if (args.includes('clone')) {
            // The clone target is relative to the clone's cwd (the tenant folder).
            await mkdir(join(opts!.cwd!, args[args.length - 1], '.git'), { recursive: true });
            return cloneOk ? ok : { success: false, stdout: '', stderr: 'timeout', exitCode: -1 };
          }
          if (args.includes('rev-parse') || args.includes('--show-current'))
            return { ...ok, stdout: task.branch };
          return ok;
        },
      ),
    };
    return { runner, git: new GitService(runner as any) };
  }
  afterEach(async () => {
    const ws = real().workspace;
    await rm(ws, { recursive: true, force: true });
    await rm(`${ws}.partial`, { recursive: true, force: true });
  });
  test('the clone gets its own long timeout and is moved in only when complete', async () => {
    const { git, runner } = fake();
    await git.prepare(real(), 'main', remote, { newBranch: true });
    const clone = runner.run.mock.calls.find((c) => c[1].includes('clone'))!;
    expect(join(clone[2]!.cwd!, clone[1][clone[1].length - 1])).toBe(`${real().workspace}.partial`);
    expect(clone[2]!.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(existsSync(join(real().workspace, '.git'))).toBe(true);
    expect(existsSync(`${real().workspace}.partial`)).toBe(false);
    // The credential scan lists every tracked file: tens of thousands in a big repository.
    const listing = runner.run.mock.calls.find((c) => c[1].includes('ls-files'))!;
    expect(listing[2]!.maxOutputBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });
  test('an interrupted clone leaves nothing behind for the next attempt', async () => {
    const { git } = fake(false);
    await expect(git.prepare(real(), 'main', remote, { newBranch: true })).rejects.toThrow(
      'Git clone failed',
    );
    expect(existsSync(real().workspace)).toBe(false);
    expect(existsSync(`${real().workspace}.partial`)).toBe(false);
  });
  test('a lock left by a killed git in an existing workspace is removed', async () => {
    const ws = real().workspace;
    await mkdir(join(ws, '.git'), { recursive: true });
    await writeFile(join(ws, '.git', 'index.lock'), '');
    const { git, runner } = fake();
    await git.prepare(real(), 'main', remote, { resetToBase: true });
    expect(existsSync(join(ws, '.git', 'index.lock'))).toBe(false);
    expect(runner.run.mock.calls.some((c) => c[1].includes('reset'))).toBe(true);
  });
});
