import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DockerRunnerService } from '../src/agents/docker-runner.service';
import { ProcessRunnerService } from '../src/agents/process-runner.service';
import { config, workspace } from '../src/config';
import { loadTenants } from '../src/tenants/tenants';
import { DataSource } from 'typeorm';
import { AgentRun } from '../src/database/entities';
import { database } from './db';
const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0';
const runner = {
  type: 'docker' as const,
  image: 'postgres:16-alpine',
  network: 'none',
  workdir: '/app',
  env: { APP_ENV: 'testing', DB_PASSWORD: 'db-secret-value' },
  memory: '256m',
  cpus: '1',
};
let cwd: string;
beforeEach(async () => {
  cwd = workspace('acme', id);
  await mkdir(`${cwd}/.git`, { recursive: true });
});
afterEach(async () => {
  await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
});
const opts = () => ({ cwd, taskId: id, tenantId: 'acme', agent: 'tester', timeoutMs: 20000 });
describe('invocation', () => {
  function fake() {
    const run = jest
      .fn()
      .mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    return { run, service: new DockerRunnerService({ run } as any) };
  }
  test('is built only from configuration, hardened, with secrets out of argv', async () => {
    const x = fake();
    await x.service.run(runner, ['./run-tests.sh', '--filter', 'Greet'], opts());
    const [bin, args, options] = x.run.mock.calls[0];
    expect(bin).toBe('docker');
    const joined = args.join(' ');
    for (const part of [
      'run --rm',
      '--network none',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--pids-limit 1024',
      '--memory 256m',
      '--workdir /app',
      `type=bind,source=${cwd},target=/app`,
      `type=bind,source=${cwd}/.git,target=/app/.git,readonly`,
      '--env APP_ENV --env DB_PASSWORD --env AI_TASK_ID',
      '--entrypoint ./run-tests.sh postgres:16-alpine --filter Greet',
    ])
      expect(joined).toContain(part);
    expect(joined).not.toContain('db-secret-value');
    expect(args[args.indexOf('--user') + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(options.env).toMatchObject({ DB_PASSWORD: 'db-secret-value', AI_TASK_ID: id });
    expect(options.displayCommand).not.toContain('db-secret-value');
  });
  test('HOME/PATH for the container go inline: the docker CLI keeps its own', async () => {
    const x = fake();
    await x.service.run(
      { ...runner, env: { HOME: '/tmp', TOKEN: 'secret-value' } },
      ['true'],
      opts(),
    );
    const [, args, options] = x.run.mock.calls[0];
    expect(args.join(' ')).toContain('--env HOME=/tmp --env TOKEN --env AI_TASK_ID');
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.TOKEN).toBe('secret-value');
    expect(args.join(' ')).not.toContain('secret-value');
  });
  test('extra mounts are read-only and only from the tenant workspaces', async () => {
    const x = fake();
    const extra = `${config().WORKSPACE_ROOT}/acme/.checks-${id}/cur`;
    await mkdir(extra, { recursive: true });
    await x.service.run(runner, ['true'], {
      ...opts(),
      mounts: [{ source: extra, target: '/scan/cur' }],
    });
    expect(x.run.mock.calls[0][1].join(' ')).toContain(
      `type=bind,source=${extra},target=/scan/cur,readonly`,
    );
    await mkdir(`${config().WORKSPACE_ROOT}/globex/x`, { recursive: true });
    await expect(
      x.service.run(runner, ['true'], {
        ...opts(),
        mounts: [{ source: `${config().WORKSPACE_ROOT}/globex/x`, target: '/scan/cur' }],
      }),
    ).rejects.toThrow('Mount outside the tenant workspaces');
  });
  test('open files limit is applied only when configured', async () => {
    const x = fake();
    await x.service.run({ ...runner, nofile: 65536 }, ['true'], opts());
    await x.service.run(runner, ['true'], opts());
    const [withLimit, without] = [x.run.mock.calls[0][1], x.run.mock.calls[2][1]];
    expect(withLimit.join(' ')).toContain('--ulimit nofile=65536:65536');
    expect(without).not.toContain('--ulimit');
  });
  test('always removes the container, even when the run throws', async () => {
    const x = fake();
    x.run.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(x.service.run(runner, ['true'], opts())).rejects.toThrow('spawn failed');
    const cleanup = x.run.mock.calls[1][1];
    expect(cleanup.slice(0, 2)).toEqual(['rm', '--force']);
    expect(cleanup[2]).toBe(x.run.mock.calls[0][1][x.run.mock.calls[0][1].indexOf('--name') + 1]);
  });
  test('refuses a directory that is not the task workspace', async () => {
    const x = fake();
    await expect(x.service.run(runner, ['true'], { ...opts(), cwd: '/tmp' })).rejects.toThrow(
      'not isolated',
    );
    expect(x.run).not.toHaveBeenCalled();
  });
  test('configuration refuses host network, root and odd images', () => {
    const yaml = (r: string) => `
tenants:
  - id: t
    name: T
    git: { authorName: B, authorEmail: b@t.test }
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [{ id: gh, type: github, token: x }]
    projects: [{ id: api, host: gh, repository: t/api, test: [npm, test], runner: ${r} }]
`;
    const ok = loadTenants(yaml('{ type: docker, image: app:latest, workdir: /app }'), {});
    expect(ok[0].projects[0].runner).toMatchObject({ network: 'none', memory: '4g', cpus: '2' });
    expect(() =>
      loadTenants(yaml('{ type: docker, image: app, workdir: /app, network: host }'), {}),
    ).toThrow('host network is not allowed');
    expect(() =>
      loadTenants(yaml('{ type: docker, image: app, workdir: /app, user: "0:0" }'), {}),
    ).toThrow('root is not allowed');
    expect(() =>
      loadTenants(yaml('{ type: docker, image: "app; rm -rf /", workdir: /app }'), {}),
    ).toThrow('docker image reference');
  });
});
// Real daemon, when available (WSL with Docker): proves the isolation actually holds.
const dockerReady =
  spawnSync('docker', ['image', 'inspect', runner.image], { stdio: 'ignore' }).status === 0;
(dockerReady ? describe : describe.skip)('real container', () => {
  jest.setTimeout(60000);
  let db: DataSource, service: DockerRunnerService;
  beforeAll(async () => {
    db = await database();
    service = new DockerRunnerService(new ProcessRunnerService(db));
  });
  afterAll(async () => {
    // Runs are audited like any other command, without the secret values.
    const runs = await db.getRepository(AgentRun).findBy({ taskId: id });
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(runs)).not.toContain('db-secret-value');
    await db.destroy();
  });
  const leftovers = () =>
    spawnSync('docker', ['ps', '-a', '-q', '--filter', `label=ai-dev-team.task=${id}`], {
      encoding: 'utf8',
    }).stdout.trim();
  test('runs as the worker user on the workspace, with .git read-only', async () => {
    await writeFile(`${cwd}/.git/HEAD`, 'ref: refs/heads/x\n');
    const script = [
      'id -u > uid.txt',
      'echo "$APP_ENV:$AI_TASK_ID" > env.txt',
      'if echo x >> .git/HEAD 2>/dev/null; then echo writable; else echo readonly; fi > git.txt',
    ].join('; ');
    const r = await service.run(runner, ['/bin/sh', '-c', script], opts());
    expect(r).toMatchObject({ success: true, exitCode: 0 });
    expect((await readFile(`${cwd}/uid.txt`, 'utf8')).trim()).toBe(String(process.getuid!()));
    expect((await readFile(`${cwd}/env.txt`, 'utf8')).trim()).toBe(`testing:${id}`);
    expect((await readFile(`${cwd}/git.txt`, 'utf8')).trim()).toBe('readonly');
    expect(await readFile(`${cwd}/.git/HEAD`, 'utf8')).toBe('ref: refs/heads/x\n');
    expect(leftovers()).toBe('');
  });
  test('network "none" really has no network', async () => {
    const r = await service.run(
      runner,
      [
        '/bin/sh',
        '-c',
        'wget -q -T 3 -O- http://1.1.1.1 >/dev/null 2>&1 && echo online || echo offline',
      ],
      opts(),
    );
    expect(r.stdout.trim()).toBe('offline');
  });
  test('a timeout kills the run and leaves no container behind', async () => {
    const r = await service.run(runner, ['/bin/sh', '-c', 'sleep 60'], {
      ...opts(),
      timeoutMs: 3000,
    });
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('timed out');
    expect(leftovers()).toBe('');
  });
});
