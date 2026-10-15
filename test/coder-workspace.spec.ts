import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { CoderWorkspace, changedRepositories } from '../src/workspaces/coder-workspace';
import { LocalWorkspace } from '../src/workspaces/local-workspace';
import { shellLine, shellQuote } from '../src/workspaces/shell';
import { TaskError } from '../src/config';
const cfg = {
  type: 'coder' as const,
  url: 'https://coder.example.com',
  name: 'dev-ws',
  agent: 'main',
  root: '/root/ai-dev-team',
  reference: '/workspaces/svc',
  protect: ['/workspaces'],
};
const ID = '11111111-1111-4111-8111-111111111111';
const DIR = `/root/ai-dev-team/${ID}`;
const ok = (stdout = '') => ({ success: true, exitCode: 0, stdout, stderr: '' });
const failed = (stderr = '') => ({ success: false, exitCode: 1, stdout: '', stderr });
const coderFail = (msg: string) =>
  failed(
    `Encountered an error running "coder ssh", see "coder ssh --help" for more information\nerror: ${msg}`,
  );
function make(...results: unknown[]) {
  const run = jest.fn();
  for (const r of results) run.mockResolvedValueOnce(r);
  run.mockResolvedValue(ok());
  return { run, ws: new CoderWorkspace({ run } as any, cfg, ID, '/usr/bin/coder') };
}
const line = (run: jest.Mock, call = 0) => run.mock.calls[call][1].at(-1) as string;
test('run: one quoted line through coder ssh, cd into the task folder, audit without content', async () => {
  const { run, ws } = make(ok('x'));
  const r = await ws.run(['git', 'commit', '-m', "it's done"], {
    timeoutMs: 1000,
    env: { A: '1' },
    input: 'prompt',
  });
  expect(r.stdout).toBe('x');
  const [bin, args, opts] = run.mock.calls[0];
  expect(bin).toBe('ssh');
  expect(args[args.length - 1]).toBe(
    `sh -c ${shellQuote(`cd ${shellQuote(DIR)} && exec ${shellLine(['git', 'commit', '-m', "it's done"], { A: '1' })}`)}`,
  );
  expect(opts).toMatchObject({ input: 'prompt', auditContent: false, taskId: ID });
  expect(opts.displayCommand).not.toContain('prompt');
});
test('the coder CLI gets the operator HOME (its saved login), and only that, in every call', async () => {
  const { run, ws } = make(coderFail('workspace "dev-ws" is not running'), ok());
  await ws.run(['ls'], { timeoutMs: 1, env: { A: '1' } });
  expect(run.mock.calls.map((c) => c[0])).toEqual(['ssh', '/usr/bin/coder', 'ssh']);
  for (const [, , opts] of run.mock.calls) expect(opts.env).toEqual({ HOME: process.env.HOME });
});
test('the transport is OpenSSH without a terminal through coder ssh --stdio: stdin closes, output is byte for byte', async () => {
  const { run, ws } = make(ok());
  await ws.run(['python3', 'hook.py'], { timeoutMs: 1, input: '{}' });
  const [bin, args, opts] = run.mock.calls[0];
  expect(bin).toBe('ssh');
  expect(args.slice(0, -2)).toEqual([
    '-T',
    '-F',
    '/dev/null',
    '-o',
    `ProxyCommand=${shellQuote('/usr/bin/coder')} ssh --stdio dev-ws.main`,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
  ]);
  expect(args.at(-2)).toBe('coder.dev-ws.main');
  expect(args[args.length - 1]).toBe(
    `sh -c ${shellQuote(`cd ${shellQuote(DIR)} && exec ${shellLine(['python3', 'hook.py'])}`)}`,
  );
  expect(opts.input).toBe('{}');
});
test('a git ssh failure (coder gitssh) is not a Coder failure', async () => {
  const { ws } = make(
    failed(
      'Encountered an error running "coder gitssh", see "coder gitssh --help" for more information\nerror: exit status 255\nfatal: Could not read from remote repository.',
    ),
  );
  const r = await ws.run(['git', 'ls-remote', 'x'], { timeoutMs: 1 });
  expect(r.success).toBe(false);
});
test('at root / none', async () => {
  const { run, ws } = make(ok(), ok());
  await ws.run(['ls'], { timeoutMs: 1, at: 'root' });
  await ws.run(['ls'], { timeoutMs: 1, at: 'none' });
  expect(line(run, 0)).toContain(`cd '\\''/root/ai-dev-team'\\'' &&`);
  expect(line(run, 1)).not.toContain('cd ');
});
test('unsafe relative paths and entries never reach the Coder', async () => {
  const { run, ws } = make();
  for (const bad of ['/etc', '../x', 'a/../../b', '', 'a\0b'])
    await expect(ws.remove(bad)).rejects.toThrow(TaskError);
  await expect(ws.removeEntry('a/b')).rejects.toThrow(TaskError);
  await expect(ws.renameEntry('ok', '../x')).rejects.toThrow(TaskError);
  expect(run).not.toHaveBeenCalled();
});
test('stopped workspace: coder start, then the command again', async () => {
  const { run, ws } = make(coderFail('workspace "dev-ws" is not running'), ok(), ok('done'));
  const r = await ws.run(['true'], { timeoutMs: 1 });
  expect(r.stdout).toBe('done');
  expect(run.mock.calls[1][1]).toEqual(['start', 'dev-ws', '--yes']);
});
test('still stopped after start: retryable error', async () => {
  const { ws } = make(coderFail('is not running'), ok(), coderFail('is not running'));
  await expect(ws.run(['true'], { timeoutMs: 1 })).rejects.toMatchObject({
    retryable: true,
    message: expect.stringMatching(/parado/),
  });
});
test('unreachable Coder: retryable, mentions the VPN', async () => {
  const { ws } = make(coderFail('dial tcp: lookup coder.example.com: no such host'));
  await expect(ws.run(['true'], { timeoutMs: 1 })).rejects.toMatchObject({
    retryable: true,
    message: expect.stringMatching(/VPN/),
  });
});
test('expired Coder session: not retryable, asks for coder login', async () => {
  const { ws } = make(coderFail('You are not logged in. Try logging in'));
  await expect(ws.run(['true'], { timeoutMs: 1 })).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/coder login/),
  });
});
test('a command failing with Coder-looking words is just a failed command (focus 3)', async () => {
  const { ws } = make(failed('error: not logged in to claude; workspace is not running'));
  await expect(ws.run(['claude'], { timeoutMs: 1 })).resolves.toMatchObject({ success: false });
});
test('state, symlink and readText', async () => {
  const { run, ws } = make(ok('missing\n'), ok(), failed(), ok('-----BEGIN'), failed());
  expect(await ws.state()).toBe('missing');
  expect(line(run, 0)).toContain(DIR);
  expect(await ws.isSymlink('a')).toBe(true);
  expect(await ws.isSymlink('b')).toBe(false);
  expect(await ws.readText('k.pem', 10)).toBe('-----BEGIN');
  expect(await ws.readText('missing.pem', 10)).toBeUndefined();
});
test('readFile brings binary files back through base64, limited and inside the task folder', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const { run, ws } = make(ok(png.toString('base64')), failed());
  expect(await ws.readFile('.ai-dev-team/evidence/out/01-a.png', 1000)).toEqual(png);
  expect(line(run, 0)).toContain('base64');
  expect(line(run, 0)).toContain('.ai-dev-team/evidence/out/01-a.png');
  expect(run.mock.calls[0][2].maxOutputBytes).toBeGreaterThan(1000 * 1.33);
  expect(await ws.readFile('missing.png', 10)).toBeUndefined();
  await expect(ws.readFile('../x.png', 10)).rejects.toThrow(TaskError);
});
test('local readFile reads the bytes, up to the limit', async () => {
  const dir = await mkdtemp('/tmp/local-ws-');
  await writeFile(`${dir}/a.bin`, Buffer.from([1, 2, 3, 4]));
  const ws = Object.assign(Object.create(LocalWorkspace.prototype), { path: dir });
  expect(await ws.readFile('a.bin', 3)).toEqual(Buffer.from([1, 2, 3]));
  expect(await ws.readFile('nope.bin', 3)).toBeUndefined();
  await rm(dir, { recursive: true, force: true });
});
test('destroy removes only <root>/<task>', async () => {
  const { run, ws } = make(ok());
  await ws.destroy();
  expect(line(run)).toContain(`'\\''rm'\\'' '\\''-rf'\\'' '\\''--'\\'' '\\''${DIR}'\\''`);
});
test('protect snapshot covers each protected folder; the diff names the repositories (focus 1)', async () => {
  const { run, ws } = make(ok('/workspaces/a h1 homolog s1\n'));
  expect(await ws.protectSnapshot()).toBe('/workspaces/a h1 homolog s1\n');
  expect(line(run)).toContain('GIT_OPTIONAL_LOCKS=0');
  expect(line(run)).toContain(`'\\''/workspaces'\\''`);
  expect(
    changedRepositories(
      '/workspaces/a h1 homolog s1\n/workspaces/b h2 main s2\n',
      '/workspaces/a h1 homolog s9\n/workspaces/b h2 main s2\n/workspaces/c h3 x s3\n',
    ),
  ).toEqual(['/workspaces/a', '/workspaces/c']);
});
test('upload: base64 tar on stdin, .ai-dev-team kept out of git; symlinks refused', async () => {
  const dir = await mkdtemp('/tmp/up-');
  try {
    await mkdir(`${dir}/figma`);
    await writeFile(`${dir}/figma/a.png`, 'img');
    const { run, ws } = make(ok());
    await ws.upload(dir, '.ai-dev-team/attachments');
    const [, args, opts] = run.mock.calls[0];
    expect(args[args.length - 1]).toContain('base64 -d');
    expect(args[args.length - 1]).toContain('.git/info/exclude');
    expect(args[args.length - 1]).toContain('.ai-dev-team/attachments');
    expect(Buffer.from(opts.input, 'base64').length).toBeGreaterThan(512);
    await symlink('/etc/passwd', `${dir}/figma/link`);
    await expect(ws.upload(dir, 'x')).rejects.toThrow(/link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('local workspace keeps today’s behaviour: the folder on this machine', async () => {
  const run = jest.fn().mockResolvedValue(ok());
  const ws = new LocalWorkspace({ run } as any, '/tmp/w/acme/t');
  await ws.run(['git', 'status'], { timeoutMs: 1, taskId: 't', agent: 'git' });
  await ws.run(['git', 'clone'], { timeoutMs: 1, at: 'root' });
  expect(run.mock.calls[0]).toEqual([
    'git',
    ['status'],
    expect.objectContaining({ cwd: '/tmp/w/acme/t', taskId: 't', agent: 'git' }),
  ]);
  expect(run.mock.calls[1][2].cwd).toBe('/tmp/w/acme');
  expect(ws.attachmentsPath).toBe('/attachments');
  expect(await ws.state()).toBe('missing');
});
test('the line sent to coder ssh really works in a shell: upload, state, snapshot (no Coder)', async () => {
  const { execFile } = await import('node:child_process');
  const root = await mkdtemp('/tmp/coder-root-');
  const protect = await mkdtemp('/tmp/coder-protect-');
  const src = await mkdtemp('/tmp/coder-src-');
  // A fake "coder ssh": runs the one line it receives in a local sh (what the remote shell does).
  const run = jest.fn(
    (_bin: string, args: string[], opts: { input?: string }) =>
      new Promise((done) => {
        const child = execFile('sh', ['-c', args[args.length - 1]], (error, stdout, stderr) =>
          done({ success: !error, exitCode: error ? 1 : 0, stdout, stderr }),
        );
        child.stdin!.end(opts.input ?? '');
      }),
  );
  try {
    const exec = (cmd: string) =>
      new Promise((done) => execFile('sh', ['-c', cmd], () => done(undefined)));
    await exec(
      `cd ${protect} && mkdir repo && cd repo && git init -q && git -c user.name=a -c user.email=a@a commit -q --allow-empty -m x`,
    );
    const ws = new CoderWorkspace(
      { run } as any,
      { ...cfg, root, protect: [protect] },
      ID,
      'coder',
    );
    expect(await ws.state()).toBe('missing');
    await exec(`mkdir -p ${root}/${ID} && cd ${root}/${ID} && git init -q`);
    expect(await ws.state()).toBe('directory');
    await writeFile(`${src}/a b.txt`, "it's here");
    await ws.upload(src, '.ai-dev-team/attachments');
    expect(await ws.readText('.ai-dev-team/attachments/a b.txt', 100)).toBe("it's here");
    const before = await ws.protectSnapshot();
    expect(before).toContain(`${protect}/repo `);
    await writeFile(`${protect}/repo/new.txt`, 'x');
    expect(changedRepositories(before, await ws.protectSnapshot())).toEqual([`${protect}/repo`]);
    await ws.destroy();
    expect(await ws.state()).toBe('missing');
  } finally {
    for (const d of [root, protect, src]) await rm(d, { recursive: true, force: true });
  }
});
test('a command cut off here (timeout, output limit) has its remote processes killed in the task folder', async () => {
  const { run, ws } = make(failed('partial\nProcess timed out'), ok());
  const r = await ws.run(['claude', '--print'], { timeoutMs: 1 });
  expect(r.success).toBe(false);
  const cleanup = line(run, 1);
  expect(cleanup).toContain('/proc');
  expect(cleanup).toContain('kill');
  expect(cleanup).toContain(DIR);
  expect(cleanup).not.toContain(`cd '\''${DIR}`);
});
test('a command that just fails leaves the workspace processes alone', async () => {
  const { run, ws } = make(failed('tests failed'));
  await ws.run(['npm', 'test'], { timeoutMs: 1 });
  expect(run).toHaveBeenCalledTimes(1);
});
test('the cleanup line really kills what runs in the task folder, and only there', async () => {
  const { spawn, execFile } = await import('node:child_process');
  const root = await mkdtemp('/tmp/coder-kill-');
  const dir = `${root}/${ID}`;
  await mkdir(dir);
  const inside = spawn('sleep', ['30'], { cwd: dir });
  const outside = spawn('sleep', ['30'], { cwd: root });
  const run = jest.fn((_bin: string, args: string[]) =>
    args[args.length - 1].includes('/proc')
      ? new Promise((done) =>
          execFile('sh', ['-c', args[args.length - 1]], () =>
            done({ success: true, exitCode: 0, stdout: '', stderr: '' }),
          ),
        )
      : Promise.resolve(failed('Process timed out')),
  );
  try {
    const ws = new CoderWorkspace({ run } as any, { ...cfg, root }, ID, 'coder');
    await ws.run(['claude'], { timeoutMs: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(inside.exitCode !== null || inside.signalCode !== null).toBe(true);
    expect(outside.exitCode === null && outside.signalCode === null).toBe(true);
  } finally {
    inside.kill('SIGKILL');
    outside.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
