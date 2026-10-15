import { DEFAULT_FORMATS } from '../src/formats/formats';
import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { AgentRouter } from '../src/agents/agent-router.service';
import {
  Task,
  PullRequest,
  Outbox,
  Issue,
  Revision,
  Decision,
  Notification,
} from '../src/database/entities';
import * as settings from '../src/config';
import { attachmentsDir } from '../src/attachments/attachments';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskError } from '../src/config';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
async function setup() {
  const registry = new TenantRegistry();
  const orchestrator = new OrchestratorService(db, registry);
  const task = await orchestrator.accept('acme', item);
  // Stateful fake: HEAD follows resetTo/commit, like a real workspace.
  let head = 'a'.repeat(40);
  const git = {
    prepare: jest.fn(),
    git: jest.fn(async (_task: unknown, args: string[]) => (args[0] === 'rev-parse' ? head : '')),
    validateChanges: jest
      .fn()
      .mockResolvedValue({ files: ['src/hello.ts'], diff: '1 file changed' }),
    commit: jest.fn(async () => (head = 'b'.repeat(40))),
    push: jest.fn(),
    resetTo: jest.fn(async (_task: unknown, sha: string) => {
      head = sha;
    }),
    fetchBranch: jest.fn(async () => 'c'.repeat(40)),
    changedPaths: jest.fn(async () => ({ tracked: [], untracked: [] })),
    revertSideEffects: jest.fn(async () => [] as string[]),
    remoteBranchExists: jest.fn(async () => false),
    diff: jest.fn(async () => ({
      text: 'diff --git a/src/hello.ts b/src/hello.ts',
      untracked: [],
    })),
    ensureRemoteBranch: jest.fn(async () => true),
  };
  const agents = {
    execute: jest.fn().mockResolvedValue({
      success: true,
      stdout: 'Implemented greeting',
      stderr: '',
      exitCode: 0,
    }),
  };
  const sandbox = {
    run: jest
      .fn()
      .mockResolvedValue({ success: true, stdout: '1 test passed', stderr: '', exitCode: 0 }),
  };
  const github = {
    id: 'gh',
    cloneUrl: (repository: string) => `https://github.com/${repository}.git`,
    gitAuthHeader: () => 'Authorization: Basic test',
    ensurePullRequest: jest.fn().mockResolvedValue({
      id: '900',
      number: 8,
      title: 'AI #7',
      url: 'https://github.com/example/demo/pull/8',
      state: 'open',
    }),
    commentOnPullRequest: jest.fn(),
    pullRequestComments: jest.fn().mockResolvedValue([]),
    branchDate: jest.fn(async () => undefined),
  };
  const reporter = { report: jest.fn() };
  const containers = {
    run: jest.fn().mockResolvedValue({ success: true, stdout: 'OK', stderr: '', exitCode: 0 }),
  };
  const checks = {
    run: jest.fn().mockResolvedValue({ findings: [], tools: {}, errors: [] }),
  };
  const project = registry.project.bind(registry);
  jest
    .spyOn(registry, 'project')
    .mockImplementation((tenant, id) => ({ ...project(tenant, id), host: github }));
  const worker = new TaskWorkerService(
    db,
    {} as any,
    new AgentRouter(db, agents as any),
    sandbox as any,
    git as any,
    registry,
    reporter as any,
    containers as any,
    orchestrator,
    checks as any,
  );
  const message = {
    content: Buffer.from(
      JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'CODE', provider: 'codex' }),
    ),
  } as any;
  const channel = { ack: jest.fn(), nack: jest.fn() } as any;
  return {
    task,
    git,
    agents,
    sandbox,
    github,
    worker,
    message,
    channel,
    reporter,
    orchestrator,
    registry,
    containers,
    checks,
  };
}
test('projects with a docker runner prepare and test in their container, not the sandbox', async () => {
  const x = await setup();
  const runner = {
    type: 'docker' as const,
    image: 'portal_app',
    network: 'master_portal',
    workdir: '/var/www/portal',
    env: {},
    memory: '4g',
    cpus: '2',
  };
  const current = x.registry.project as jest.Mock;
  const base = current.getMockImplementation()!;
  current.mockImplementation((t: string, p: string) => {
    const ctx = base(t, p);
    return {
      ...ctx,
      project: {
        ...ctx.project,
        runner,
        prepare: ['composer', 'install'],
        test: ['./run-tests.sh'],
      },
    };
  });
  await x.worker.handle(x.message, x.channel);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('SUCCESS');
  expect(x.containers.run.mock.calls.map((c) => [c[1], c[2].agent])).toEqual([
    [['composer', 'install'], 'dependencies'],
    [['./run-tests.sh'], 'tester'],
  ]);
  expect(x.containers.run.mock.calls[0][0]).toBe(runner);
  expect(x.sandbox.run).not.toHaveBeenCalled();
});
function revisionMessage(task: Task, revisionId: string) {
  return {
    content: Buffer.from(
      JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'REVISE', revisionId }),
    ),
  } as any;
}
describe('revisions ("/ai ..." on the PR)', () => {
  async function done() {
    const x = await setup();
    await x.worker.handle(x.message, x.channel);
    x.agents.execute.mockClear();
    x.git.push.mockClear();
    x.git.commit.mockImplementationOnce(async () => 'd'.repeat(40));
    return x;
  }
  test('builds on the current PR head, pushes a new commit and answers on the PR', async () => {
    const x = await done();
    const revision = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: 'Rename hello to greet', origin: 'api' },
    );
    await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
    const saved = await db.getRepository(Revision).findOneByOrFail({ id: revision.id });
    expect(saved).toMatchObject({ status: 'SUCCESS', stage: 'DONE', provider: 'codex' });
    expect(saved.result).toMatchObject({ baseSha: 'c'.repeat(40), commitSha: 'd'.repeat(40) });
    // Human commits on the PR branch are the starting point, never discarded.
    expect(x.git.fetchBranch).toHaveBeenCalled();
    expect(x.git.resetTo).toHaveBeenCalledWith(expect.anything(), 'c'.repeat(40));
    const prompt: string = x.agents.execute.mock.calls[0][1].prompt;
    expect(prompt).toContain('Rename hello to greet');
    expect(prompt).toContain(`git diff ${'a'.repeat(40)}..HEAD`);
    expect(x.git.commit).toHaveBeenLastCalledWith(
      expect.anything(),
      'fix(ai): #7 revision 1',
      expect.anything(),
    );
    expect(x.git.push).toHaveBeenCalledWith(expect.anything(), 'd'.repeat(40), expect.anything());
    expect(x.github.ensurePullRequest).toHaveBeenCalledTimes(1);
    const [repository, number, text] = x.github.commentOnPullRequest.mock.calls[0];
    expect([repository, number]).toEqual(['example/demo', 8]);
    expect(text).toContain('aplicou a revisão #1 (commit ddddddd');
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
  });
  test("the agent's answer to the reviewer is posted on the PR", async () => {
    const x = await done();
    x.agents.execute.mockResolvedValue({
      success: true,
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      message:
        'Testes ok.\n<resposta>1. Validação do motivo vazio: feita.\n2. Renomear a tabela: não apliquei, fora do escopo do card.</resposta>',
    });
    const revision = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: '- Flavia em `src/a.ts`, linha 42: validar motivo vazio', origin: 'api' },
    );
    await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
    const prompt: string = x.agents.execute.mock.calls[0][1].prompt;
    expect(prompt).toContain('comentários com arquivo e linha referem-se ao código do PR');
    const text: string = x.github.commentOnPullRequest.mock.calls[0][2];
    expect(text).toContain('1. Validação do motivo vazio: feita.');
    expect(text).toContain('2. Renomear a tabela: não apliquei, fora do escopo do card.');
    expect(text).not.toContain('<resposta>');
  });
  test('later revisions see the earlier ones and a failure is reported on the PR', async () => {
    const x = await done();
    const first = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: 'First change', origin: 'api' },
    );
    await x.worker.handle(revisionMessage(x.task, first.id), x.channel);
    const second = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: 'Second change', origin: 'api' },
    );
    x.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
    await x.worker.handle(revisionMessage(x.task, second.id), x.channel);
    expect(x.agents.execute.mock.calls[1][1].prompt).toContain('- #1 (SUCCESS): First change');
    const saved = await db.getRepository(Revision).findOneByOrFail({ id: second.id });
    expect(saved.status).toBe('FAILED');
    expect(x.github.commentOnPullRequest.mock.calls[1][2]).toContain(
      'não conseguiu aplicar a revisão #2: TESTS: Tests failed: boom',
    );
    // A failed revision never touches the task or its PR state.
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'SUCCESS',
    );
  });
  test('revision attachments are mounted with the issue ones and listed in the prompt', async () => {
    const x = await done();
    const revision = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      {
        instructions: 'Match the mockup',
        origin: 'api',
        attachments: [{ name: 'mock.png', contentType: 'image/png', size: 5 }],
      },
    );
    const issue = await db.getRepository(Issue).findOneByOrFail({ id: x.task.issueId });
    const dir = attachmentsDir('acme', issue.source, issue.externalId);
    await mkdir(`${dir}/rev-${revision.id}`, { recursive: true });
    try {
      await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
      const input = x.agents.execute.mock.calls[0][1];
      expect(input.attachments.dir).toBe(dir);
      expect(input.attachments.files[0].name).toBe(`rev-${revision.id}/mock.png`);
      expect(input.prompt).toContain(`/attachments/rev-${revision.id}/mock.png`);
    } finally {
      await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
    }
  });
  test('rules: only after the PR, idempotent per trigger, bounded, tenant-scoped', async () => {
    const x = await setup();
    const request = { instructions: 'x', origin: 'github-comment' as const };
    await expect(
      x.orchestrator.requestRevision('acme', { taskId: x.task.id }, request),
    ).rejects.toMatchObject({ reason: 'not_ready' });
    await x.worker.handle(x.message, x.channel);
    const byPr = { repository: 'Example/Demo', prNumber: 8 };
    const a = await x.orchestrator.requestRevision('acme', byPr, { ...request, externalId: 'c-1' });
    const again = await x.orchestrator.requestRevision('acme', byPr, {
      ...request,
      externalId: 'c-1',
    });
    expect(again.id).toBe(a.id);
    await expect(x.orchestrator.requestRevision('globex', byPr, request)).rejects.toMatchObject({
      reason: 'not_found',
    });
    await expect(
      x.orchestrator.requestRevision('acme', { repository: 'example/other', prNumber: 8 }, request),
    ).rejects.toMatchObject({ reason: 'not_found' });
    for (let i = 1; i < 10; i++)
      await x.orchestrator.requestRevision('acme', byPr, { ...request, externalId: `c-${i + 1}` });
    await expect(x.orchestrator.requestRevision('acme', byPr, request)).rejects.toMatchObject({
      reason: 'limit',
    });
    expect(await db.getRepository(Revision).count()).toBe(10);
  });
});
test('simulated issue → persisted task → worker → tested commit → PR → SUCCESS; duplicate does not rerun', async () => {
  const x = await setup();
  await x.worker.handle(x.message, x.channel);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('SUCCESS');
  expect(await db.getRepository(PullRequest).count()).toBe(1);
  expect(x.git.commit).toHaveBeenCalledTimes(1);
  expect(x.git.push).toHaveBeenCalledTimes(1);
  expect(x.channel.ack).toHaveBeenCalledTimes(1);
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).toHaveBeenCalledTimes(1);
  expect(x.github.ensurePullRequest).toHaveBeenCalledTimes(1);
});
test('uses the tenant key, author, test command and closing reference', async () => {
  const x = await setup();
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).toHaveBeenCalledWith(
    'codex',
    expect.objectContaining({ tenantId: 'acme', apiKey: 'test-acme-openai-key' }),
  );
  expect(x.git.commit).toHaveBeenCalledWith(expect.anything(), 'feat(ai): implement #7', {
    name: 'Acme Bot',
    email: 'bot@acme.test',
  });
  expect(x.sandbox.run).toHaveBeenCalledWith(
    'npm',
    ['test'],
    expect.objectContaining({ tenantId: 'acme', agent: 'tester' }),
    false,
  );
  const [repository, pr] = x.github.ensurePullRequest.mock.calls[0];
  expect(repository).toBe('example/demo');
  expect(pr.title).toBe('AI: #7 Add greeting');
  expect(pr.body).toContain('Closes #7');
});
test('attachments reach the agent as a read-only directory listed in the prompt', async () => {
  const x = await setup();
  const issue = await db.getRepository(Issue).findOneByOrFail({ id: x.task.issueId });
  const files = [{ name: 'screen.png', contentType: 'image/png', size: 3 }];
  await db.getRepository(Issue).update(issue.id, { attachments: files });
  const dir = attachmentsDir('acme', issue.source, issue.externalId);
  await mkdir(dir, { recursive: true });
  try {
    await x.worker.handle(x.message, x.channel);
    const input = x.agents.execute.mock.calls[0][1];
    expect(input.attachments).toEqual({ dir, files });
    expect(input.prompt).toContain('- /attachments/screen.png (image/png, 3 bytes)');
  } finally {
    await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
  }
});
test('missing attachment files fail the task instead of running the agent blind', async () => {
  const x = await setup();
  await db
    .getRepository(Issue)
    .update(x.task.issueId, { attachments: [{ name: 'gone.pdf', contentType: 'x', size: 1 }] });
  await x.worker.handle(x.message, x.channel);
  const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
  expect(task.status).toBe('FAILED');
  expect(task.error).toContain('Attachments missing on disk: gone.pdf');
  expect(x.agents.execute).not.toHaveBeenCalled();
});
const quota = {
  success: false,
  stdout: '',
  stderr: 'insufficient_quota: You exceeded your current quota',
  exitCode: 1,
};
test('exhausted credential falls back to the next one from a clean base and succeeds', async () => {
  const x = await setup();
  x.agents.execute
    .mockResolvedValueOnce(quota)
    .mockResolvedValueOnce({ success: true, stdout: 'done', stderr: '', exitCode: 0 });
  await x.worker.handle(x.message, x.channel);
  const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
  expect(task.status).toBe('SUCCESS');
  expect(task.provider).toBe('claude');
  expect(task.result?.agentAttempts).toEqual([
    expect.objectContaining({ credential: 'openai-main', outcome: 'quota' }),
    expect.objectContaining({
      credential: 'claude-max',
      outcome: 'success',
      model: 'claude-sonnet-5',
    }),
  ]);
  expect(x.agents.execute.mock.calls[1]).toEqual([
    'claude',
    expect.objectContaining({ credentialId: 'claude-max', model: 'claude-sonnet-5' }),
  ]);
  // Once before the first run, once before the fallback.
  expect(x.git.resetTo).toHaveBeenCalledTimes(2);
  expect(x.git.resetTo).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(40));
});
test('all credentials exhausted: task waits for capacity without spending attempts', async () => {
  const x = await setup();
  x.agents.execute.mockResolvedValue(quota);
  await x.worker.handle(x.message, x.channel);
  const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
  expect(task).toMatchObject({ status: 'PENDING', stage: 'WAITING_CAPACITY', attempts: 0 });
  expect(task.error).toContain('All AI credentials unavailable');
  // claude-max has a 60 min quota cooldown, the earliest of the two.
  const retry = await db
    .getRepository(Outbox)
    .findOne({ order: { availableAt: 'DESC' }, where: {} });
  const minutes = (retry!.availableAt.getTime() - Date.now()) / 60000;
  expect(minutes).toBeGreaterThan(58);
  expect(minutes).toBeLessThanOrEqual(60);
  expect(x.git.commit).not.toHaveBeenCalled();
  // The next delivery before the cooldown does not call any AI.
  x.agents.execute.mockClear();
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).not.toHaveBeenCalled();
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).attempts).toBe(0);
});
test('a failure of the task itself does not burn the other credentials', async () => {
  const x = await setup();
  x.agents.execute.mockResolvedValue({
    success: false,
    stdout: '',
    stderr: 'compilation error in src/app.ts',
    exitCode: 1,
  });
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).toHaveBeenCalledTimes(1);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('FAILED');
});
test('reports the PR, and a final failure, back to the source tracker', async () => {
  const ok = await setup();
  await ok.worker.handle(ok.message, ok.channel);
  expect(ok.reporter.report).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'acme' }),
    { source: 'github', externalKey: '#7' },
    { type: 'pr', prUrl: 'https://github.com/example/demo/pull/8' },
  );
  await db.destroy();
  db = await database();
  const bad = await setup();
  bad.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
  bad.reporter.report.mockRejectedValue(new Error('tracker down'));
  await bad.worker.handle(bad.message, bad.channel);
  expect(bad.reporter.report.mock.calls[0][2]).toMatchObject({ type: 'failed' });
  // A broken tracker never changes the task outcome.
  expect((await db.getRepository(Task).findOneByOrFail({ id: bad.task.id })).status).toBe('FAILED');
});
test('failed tests prevent commit, push and PR; delivery rejected', async () => {
  const x = await setup();
  x.sandbox.run.mockResolvedValue({
    success: false,
    stdout: '',
    stderr: 'Test assertion failed',
    exitCode: 1,
  });
  await x.worker.handle(x.message, x.channel);
  const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
  expect(task.status).toBe('FAILED');
  expect(task.error).toContain('TESTS');
  expect(x.git.commit).not.toHaveBeenCalled();
  expect(x.github.ensurePullRequest).not.toHaveBeenCalled();
  expect(x.channel.ack).not.toHaveBeenCalled();
  expect(x.channel.nack).toHaveBeenCalledWith(x.message, false, false);
});
test('transient GitHub failure schedules bounded retry and reuses committed work', async () => {
  const x = await setup();
  x.github.ensurePullRequest.mockRejectedValueOnce(new TaskError('GitHub 503', true));
  await x.worker.handle(x.message, x.channel);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('PENDING');
  expect(await db.getRepository(Outbox).count()).toBe(2);
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).toHaveBeenCalledTimes(1);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('SUCCESS');
});
test('permanent agent error fails visibly and never pushes', async () => {
  const x = await setup();
  x.agents.execute.mockResolvedValue({
    success: false,
    stdout: '',
    stderr: 'Unavailable CLI',
    exitCode: 1,
  });
  await x.worker.handle(x.message, x.channel);
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).error).toContain(
    'AGENT',
  );
  expect(x.git.push).not.toHaveBeenCalled();
});

test('retry budget ends in FAILED without endless requeue', async () => {
  const x = await setup();
  x.github.ensurePullRequest.mockRejectedValue(new TaskError('GitHub 503', true));
  for (let i = 0; i < 3; i++) await x.worker.handle(x.message, x.channel);
  const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
  expect(task.status).toBe('FAILED');
  expect(task.attempts).toBe(3);
  expect(x.channel.ack).not.toHaveBeenCalled();
  expect(await db.getRepository(Outbox).count()).toBe(3);
});
test('crash after commit resumes tests and push without running agent again', async () => {
  const x = await setup();
  await db
    .getRepository(Task)
    .update(x.task.id, { status: 'RUNNING', attempts: 1, result: { baseSha: 'a'.repeat(40) } });
  x.git.git.mockResolvedValue('b'.repeat(40));
  await x.worker.handle(x.message, x.channel);
  expect(x.agents.execute).not.toHaveBeenCalled();
  expect(x.git.commit).not.toHaveBeenCalled();
  expect(x.sandbox.run).toHaveBeenCalled();
  expect(x.git.push).toHaveBeenCalledWith(expect.anything(), 'b'.repeat(40), expect.anything());
  expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('SUCCESS');
});
describe('fixing from failing tests', () => {
  const fail = {
    success: false,
    stdout: 'FAILURES: GreetTest::testEmpty',
    stderr: 'exit 1',
    exitCode: 1,
  };
  const pass = { success: true, stdout: 'OK (3 tests)', stderr: '', exitCode: 0 };
  test('failing tests go back to the agent, which fixes on top of its own edits', async () => {
    const x = await setup();
    x.sandbox.run.mockResolvedValueOnce(fail).mockResolvedValueOnce(pass);
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    expect(task.result).toMatchObject({ fixAttempts: 1, validation: { exitCode: 0 } });
    expect(x.agents.execute).toHaveBeenCalledTimes(2);
    const fixPrompt: string = x.agents.execute.mock.calls[1][1].prompt;
    expect(fixPrompt).toContain('tentativa de correção 1 de 2');
    expect(fixPrompt).toContain('FAILURES: GreetTest::testEmpty');
    expect(fixPrompt).toContain('Add greeting');
    // The fix keeps the first implementation: only the initial reset happened.
    expect(x.git.resetTo).toHaveBeenCalledTimes(1);
    expect(x.git.commit).toHaveBeenCalledTimes(1);
  });
  test('gives up after TEST_FIX_ATTEMPTS and never commits', async () => {
    const x = await setup();
    x.sandbox.run.mockResolvedValue(fail);
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('FAILED');
    expect(task.result?.fixAttempts).toBe(2);
    expect(x.agents.execute).toHaveBeenCalledTimes(3);
    expect(x.git.commit).not.toHaveBeenCalled();
  });
  test('a resumed commit that fails tests is not handed to the agent', async () => {
    const x = await setup();
    await db
      .getRepository(Task)
      .update(x.task.id, { status: 'RUNNING', attempts: 1, result: { baseSha: 'a'.repeat(40) } });
    x.git.git.mockResolvedValue('b'.repeat(40));
    x.sandbox.run.mockResolvedValue(fail);
    await x.worker.handle(x.message, x.channel);
    expect(x.agents.execute).not.toHaveBeenCalled();
  });
  test('the tenant harness is resolved and handed to the agent', async () => {
    const { mkdtemp, writeFile, mkdir: mk } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(`${tmpdir()}/h-`);
    await mk(`${root}/skills/vandelay-coding`, { recursive: true });
    await writeFile(`${root}/skills/vandelay-coding/SKILL.md`, 'x');
    const x = await setup();
    const current = x.registry.project as jest.Mock;
    const base = current.getMockImplementation()!;
    current.mockImplementation((t: string, p: string) => {
      const ctx = base(t, p);
      return {
        ...ctx,
        tenant: { ...ctx.tenant, harness: { path: root, skills: ['skills'], agents: [] } },
      };
    });
    try {
      await x.worker.handle(x.message, x.channel);
      expect(x.agents.execute.mock.calls[0][1].harness.skills).toEqual([
        { name: 'vandelay-coding', path: expect.stringContaining('skills/vandelay-coding') },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe('sub-task delivery (one PR, one commit per sub-task)', () => {
  const steps = ['A-1', 'A-2', 'A-3'].map((key, i) => ({
    externalId: String(i + 1),
    key,
    title: `Step ${i + 1}`,
    body: `Do part ${i + 1}`,
    revisionId: [
      '',
      '2b9ab31c-3a41-4f1e-9c4c-1d1d6c1f0a02',
      '3c8bc42d-4b52-4a2f-8d5d-2e2e7d2a1b03',
    ][i],
    attachments: [],
  }));
  async function delivery() {
    const x = await setup();
    await db.getRepository(Issue).update(x.task.issueId, { meta: { steps } });
    let sha = 0;
    x.git.commit.mockImplementation(async () => String(++sha).repeat(40));
    return x;
  }
  const step = (x: Awaited<ReturnType<typeof delivery>>, n: number) =>
    revisionMessage(x.task, steps[n].revisionId);
  test('the task delivers step 1, then each step is queued after the previous one lands', async () => {
    const x = await delivery();
    await x.worker.handle(x.message, x.channel);
    expect((x.git.commit.mock.calls[0] as unknown[])[1]).toBe('feat(ai): A-1 Step 1');
    const prompt1: string = x.agents.execute.mock.calls[0][1].prompt;
    expect(prompt1).toContain('Etapa atual — A-1: Step 1');
    expect(prompt1).toContain('1. A-1 — Step 1 (ATUAL)');
    expect(prompt1).toContain('3. A-3 — Step 3 (próxima)');
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain('- A-2 Step 2');
    const revisions = () => db.getRepository(Revision).find({ order: { number: 'ASC' } as never });
    expect((await revisions()).map((r) => [r.externalKey, r.status])).toEqual([['A-2', 'PENDING']]);
    await x.worker.handle(step(x, 1), x.channel);
    expect((x.git.commit.mock.calls[1] as unknown[])[1]).toBe('feat(ai): A-2 Step 2');
    expect(x.agents.execute.mock.calls[1][1].prompt).toContain('1. A-1 — Step 1 (concluída)');
    expect((await revisions()).map((r) => [r.externalKey, r.status])).toEqual([
      ['A-2', 'SUCCESS'],
      ['A-3', 'PENDING'],
    ]);
    await x.worker.handle(step(x, 2), x.channel);
    expect((x.git.commit.mock.calls[2] as unknown[])[1]).toBe('feat(ai): A-3 Step 3');
    const events = x.reporter.report.mock.calls.map((c) => [c[1].externalKey, c[2].type]);
    expect(events).toEqual([
      ['A-1', 'step-done'],
      ['#7', 'pr-opened'],
      ['A-2', 'step-started'],
      ['A-2', 'step-done'],
      ['A-3', 'step-started'],
      ['A-3', 'step-done'],
      ['#7', 'completed'],
    ]);
    // Steps never touch the task status nor the PR count.
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'SUCCESS',
    );
    expect(x.github.ensurePullRequest).toHaveBeenCalledTimes(1);
  });
  test('a failed step stops the chain; its retry resumes it', async () => {
    const x = await delivery();
    await x.worker.handle(x.message, x.channel);
    x.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
    await x.worker.handle(step(x, 1), x.channel);
    expect(await db.getRepository(Revision).count()).toBe(1);
    const failed = x.reporter.report.mock.calls.filter((c) => c[2].type === 'failed');
    expect(failed.map((c) => c[1].externalKey)).toEqual(['A-2', '#7']);
    x.sandbox.run.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    await x.orchestrator.retry('acme', x.task.id, 1);
    await x.worker.handle(step(x, 1), x.channel);
    expect(
      (await db.getRepository(Revision).find({})).map((r) => [r.externalKey, r.status]).sort(),
    ).toEqual([
      ['A-2', 'SUCCESS'],
      ['A-3', 'PENDING'],
    ]);
  });
});
describe('stacked sub-tasks (branch and PR per sub-task, team PR template)', () => {
  const steps = ['A-1', 'A-2'].map((key, i) => ({
    externalId: String(i + 1),
    key,
    title: `Step ${i + 1}`,
    body: `Do part ${i + 1}`,
    revisionId: '',
    attachments: [],
  }));
  const story = {
    key: 'A-0',
    externalId: '0',
    title: 'Story',
    body: 'Rules',
    branch: 'ai/story',
    steps,
  };
  test('creates the story branch, opens the PR into it with the template, queues the next', async () => {
    const x = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'pr-template-'));
    const template = join(dir, 'pr.md');
    await writeFile(
      template,
      'URL: {{BRANCH_URL}}\nProblema: {{PROBLEM}}\nFeito: {{SOLUTION}}\nTestes: {{TESTS_PASSING}}\nTraduções: {{TRANSLATIONS}}\nBanco: {{DATABASE}}',
    );
    const project = (x.registry.project as jest.Mock).getMockImplementation()!;
    jest.spyOn(x.registry, 'project').mockImplementation((tenant, id) => {
      const ctx = project(tenant, id);
      return {
        ...ctx,
        project: {
          ...ctx.project,
          instructions: 'Traduza PT/EN/ES.',
          pullRequest: { template, branchUrl: 'https://{key_lower}.dev.example/inicio' },
          // The team template asks for database and translations: the project declares them.
          formats: {
            pullRequest: {
              sections: [
                ...DEFAULT_FORMATS.pullRequest.sections,
                {
                  tag: 'banco',
                  placeholder: 'DATABASE',
                  ask: 'script',
                  fallback: 'Não',
                  kind: 'text',
                },
                { tag: 'traducoes', placeholder: 'TRANSLATIONS', ask: 'traduções', kind: 'check' },
              ],
            },
          },
        },
      };
    });
    await db.getRepository(Issue).update(x.task.issueId, {
      externalKey: 'A-1',
      url: 'https://acme.atlassian.net/browse/A-1',
      meta: { baseRef: 'ai/story', prTarget: 'ai/story', ensureBase: true, story, stepIndex: 0 },
    });
    x.agents.execute.mockResolvedValue({
      success: true,
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      message:
        'Pronto.\n<pr><problema>Sem recusa</problema><solucao>Endpoint novo</solucao><traducoes>Sim</traducoes><banco>Não</banco></pr>',
    });
    await x.worker.handle(x.message, x.channel);
    // The story branch did not exist: created from the default branch tip, then built on.
    expect(x.git.prepare.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ['main', { resetToBase: true, newBranch: true, hidden: [] }],
      ['ai/story', { resetToBase: true, newBranch: true, hidden: [] }],
    ]);
    expect(x.git.ensureRemoteBranch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ai/story',
      'a'.repeat(40),
    );
    const prompt: string = x.agents.execute.mock.calls[0][1].prompt;
    expect(prompt).toContain('uma branch e um PR por sub-tarefa');
    expect(prompt).toContain('Etapa atual — A-1: Step 1');
    expect(prompt).toContain('Traduza PT/EN/ES.');
    expect(prompt).toContain('<como_testar>');
    expect((x.git.commit.mock.calls[0] as unknown[])[1]).toBe('feat(ai): A-1 Add greeting');
    const pr = x.github.ensurePullRequest.mock.calls[0][1];
    expect(pr.base).toBe('ai/story');
    expect(pr.title).toBe('A-1 Add greeting');
    expect(pr.body).toBe(
      'URL: https://a-1.dev.example/inicio\nProblema: Sem recusa\nFeito: Endpoint novo\nTestes: ✅\nTraduções: ✅\nBanco: Não',
    );
    // Next sub-task: stacked on this branch, PR still into the story branch.
    const next = await db.getRepository(Issue).findOneByOrFail({ externalKey: 'A-2' });
    expect(next.meta).toMatchObject({ baseRef: x.task.branch, prTarget: 'ai/story', stepIndex: 1 });
    expect(x.reporter.report.mock.calls.map((c) => [c[1].externalKey, c[2].type])).toEqual([
      ['A-1', 'pr'],
      ['A-2', 'step-started'],
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});
describe('operator retry and cancel', () => {
  const failTests = { success: false, stdout: '', stderr: 'boom', exitCode: 1 };
  test('a failed task starts over from the current base and can succeed', async () => {
    const x = await setup();
    x.sandbox.run.mockResolvedValue(failTests);
    await x.worker.handle(x.message, x.channel);
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe('FAILED');
    const retried = await x.orchestrator.retry('acme', x.task.id);
    expect(retried).toMatchObject({
      status: 'PENDING',
      stage: 'QUEUED',
      attempts: 0,
      result: null,
    });
    expect(await db.getRepository(Outbox).count()).toBe(2);
    x.sandbox.run.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    x.git.prepare.mockClear();
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    // Starting over: the existing workspace is moved back to the base branch tip.
    expect(x.git.prepare).toHaveBeenCalledWith(expect.anything(), 'main', expect.anything(), {
      resetToBase: true,
      newBranch: true,
      hidden: [],
    });
  });
  test('refuses retrying running, successful or already-PR tasks, and other tenants', async () => {
    const x = await setup();
    await expect(x.orchestrator.retry('acme', x.task.id)).rejects.toMatchObject({
      reason: 'conflict',
      message: expect.stringContaining('status: PENDING'),
    });
    await x.worker.handle(x.message, x.channel);
    await db.getRepository(Task).update(x.task.id, { status: 'FAILED' });
    await expect(x.orchestrator.retry('acme', x.task.id)).rejects.toMatchObject({
      message: expect.stringContaining('request a revision'),
    });
    await expect(x.orchestrator.retry('globex', x.task.id)).rejects.toMatchObject({
      reason: 'not_found',
    });
  });
  test('cancel drops a queued task; the worker never runs it; it can be retried', async () => {
    const x = await setup();
    const cancelled = await x.orchestrator.cancel('acme', x.task.id);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', error: 'Cancelled by the operator' });
    await x.worker.handle(x.message, x.channel);
    expect(x.agents.execute).not.toHaveBeenCalled();
    expect(x.channel.nack).toHaveBeenCalledWith(x.message, false, false);
    expect((await x.orchestrator.retry('acme', x.task.id)).status).toBe('PENDING');
  });
  test('a failed revision is retried from the current PR head', async () => {
    const x = await setup();
    await x.worker.handle(x.message, x.channel);
    const revision = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: 'Adjust', origin: 'api' },
    );
    x.sandbox.run.mockResolvedValue(failTests);
    await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
    expect((await db.getRepository(Revision).findOneByOrFail({ id: revision.id })).status).toBe(
      'FAILED',
    );
    const again = await x.orchestrator.retry('acme', x.task.id, 1);
    expect(again).toMatchObject({ id: revision.id, status: 'PENDING', result: null });
    x.sandbox.run.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    x.git.fetchBranch.mockClear();
    await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
    expect((await db.getRepository(Revision).findOneByOrFail({ id: revision.id })).status).toBe(
      'SUCCESS',
    );
    expect(x.git.fetchBranch).toHaveBeenCalledTimes(1);
    await expect(x.orchestrator.retry('acme', x.task.id, 7)).rejects.toMatchObject({
      reason: 'not_found',
    });
  });
});
describe('planner and reviewer roles', () => {
  /** Turns on planner/reviewer for acme (claude-max) without touching the fixture file. */
  function withRoles(x: Awaited<ReturnType<typeof setup>>) {
    const project = (x.registry.project as jest.Mock).getMockImplementation()!;
    jest.spyOn(x.registry, 'project').mockImplementation((tenant, id) => {
      const ctx = project(tenant, id);
      return {
        ...ctx,
        tenant: {
          ...ctx.tenant,
          ai: {
            ...ctx.tenant.ai,
            roles: {
              planner: [{ credential: 'claude-max', model: 'opus' }],
              reviewer: [{ credential: 'claude-max', effort: 'medium' as const }],
            },
            review: { rounds: 1 },
          },
        },
      };
    });
  }
  const answer = (message: string) => ({
    success: true,
    stdout: '{}',
    stderr: '',
    exitCode: 0,
    message,
  });
  const byRole = (replies: Record<string, unknown[]>) =>
    jest.fn(async (_provider: string, input: { role: string }) => {
      const list = replies[input.role];
      return list.length > 1 ? list.shift() : list[0];
    });
  test('plans a card without sub-tasks, codes with the plan, and the approved review reaches the PR', async () => {
    const x = await setup();
    withRoles(x);
    x.agents.execute = byRole({
      planner: [answer('Li o projeto.\n<plano>1. criar src/hello.ts</plano>')],
      coder: [answer('feito')],
      reviewer: [
        answer(
          '<revisao><veredito>aprovado</veredito><resumo>função simples e testada</resumo></revisao>',
        ),
      ],
    });
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    const calls = x.agents.execute.mock.calls.map((c) => c[1] as any);
    expect(calls.map((c) => [c.role, !!c.readOnly])).toEqual([
      ['planner', true],
      ['coder', false],
      ['reviewer', true],
    ]);
    expect(calls[0].model).toBe('opus');
    expect(calls[1].prompt).toContain('Plano do arquiteto');
    expect(calls[1].prompt).toContain('1. criar src/hello.ts');
    expect(calls[2].prompt).toContain('diff --git a/src/hello.ts');
    expect(calls[2].effort).toBe('medium');
    expect(task.result!.review).toMatchObject({ final: 'approved' });
    expect(x.git.commit).toHaveBeenCalledTimes(1);
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain(
      'Revisão automática: aprovado.\n- Rodada 1: aprovado — função simples e testada',
    );
  });
  test('review findings go back to the coder and the tests run again before the commit', async () => {
    const x = await setup();
    withRoles(x);
    x.agents.execute = byRole({
      planner: [answer('<plano>1. passo</plano>')],
      coder: [answer('feito'), answer('ajustado')],
      reviewer: [
        answer(
          '<revisao><veredito>ajustes</veredito><problemas>1. src/hello.ts:1 — falta teste</problemas></revisao>',
        ),
      ],
    });
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    const calls = x.agents.execute.mock.calls.map((c) => c[1] as any);
    expect(calls.map((c) => c.role)).toEqual(['planner', 'coder', 'reviewer', 'coder']);
    expect(calls[3].prompt).toContain('o revisor de código pediu ajustes');
    expect(calls[3].prompt).toContain('1. src/hello.ts:1 — falta teste');
    // Tests after the coder and again after the review fix; one commit with both.
    expect(x.sandbox.run).toHaveBeenCalledTimes(2);
    expect(x.git.commit).toHaveBeenCalledTimes(1);
    expect(task.result!.review).toMatchObject({ final: 'changes-addressed' });
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain('falta teste');
  });
  test('a reviewer without capacity does not block the delivery; the PR says so', async () => {
    const x = await setup();
    withRoles(x);
    x.agents.execute = byRole({
      planner: [
        { success: false, stdout: '', stderr: '', exitCode: 1, errorText: 'usage limit reached' },
      ],
      coder: [answer('feito')],
      reviewer: [
        { success: false, stdout: '', stderr: '', exitCode: 1, errorText: 'usage limit reached' },
      ],
    });
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    // claude-max is parked by the planner: the coder falls back to openai-main.
    expect(task.status).toBe('SUCCESS');
    expect(task.result!.plan).toBe('');
    expect(task.result!.review).toMatchObject({ final: 'skipped' });
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain(
      'Revisão automática não realizada',
    );
  });
});
describe('security checks', () => {
  function withChecks(x: Awaited<ReturnType<typeof setup>>, blocking = true) {
    const project = (x.registry.project as jest.Mock).getMockImplementation()!;
    jest.spyOn(x.registry, 'project').mockImplementation((tenant, id) => {
      const ctx = project(tenant, id);
      return {
        ...ctx,
        project: {
          ...ctx.project,
          checks: { tools: ['semgrep'], blocking, reportOnly: [] } as any,
        },
      };
    });
  }
  const finding = {
    tool: 'semgrep',
    rule: 'tainted-sql',
    file: 'src/hello.ts',
    line: 3,
    message: 'SQL com entrada do usuário',
  };
  const found = {
    findings: [finding],
    tools: { semgrep: { files: 1, now: 1, base: 0 } },
    errors: [],
  };
  const clean = { findings: [], tools: { semgrep: { files: 1, now: 0, base: 0 } }, errors: [] };
  test('new findings go to the fixer; tests run again; the PR shows the clean result', async () => {
    const x = await setup();
    withChecks(x);
    x.checks.run.mockResolvedValueOnce(found).mockResolvedValue(clean);
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    // Compared against the task's base commit.
    expect(x.checks.run.mock.calls[0][2]).toBe('a'.repeat(40));
    const prompts = x.agents.execute.mock.calls.map((c) => c[1].prompt as string);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('checagens de segurança encontraram problemas');
    expect(prompts[1]).toContain('[semgrep] tainted-sql em src/hello.ts:3');
    expect(x.agents.execute.mock.calls[1][1].role).toBe('fixer');
    expect(x.sandbox.run).toHaveBeenCalledTimes(2);
    expect(x.git.commit).toHaveBeenCalledTimes(1);
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain(
      'Checagens de segurança: nenhum achado novo (semgrep: 1 arquivo(s))',
    );
  });
  test('findings that survive every fix fail the task before any commit', async () => {
    const x = await setup();
    withChecks(x);
    x.checks.run.mockResolvedValue(found);
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).not.toBe('SUCCESS');
    expect(task.error).toContain('Security checks failed');
    expect(x.git.commit).not.toHaveBeenCalled();
    expect(x.git.push).not.toHaveBeenCalled();
  });
  test('report-only tools never block; the others still do', async () => {
    const x = await setup();
    const project = (x.registry.project as jest.Mock).getMockImplementation()!;
    jest.spyOn(x.registry, 'project').mockImplementation((tenant, id) => {
      const ctx = project(tenant, id);
      return {
        ...ctx,
        project: {
          ...ctx.project,
          checks: { tools: ['osv', 'semgrep'], blocking: true, reportOnly: ['osv'] } as any,
        },
      };
    });
    x.checks.run.mockResolvedValue({
      findings: [{ tool: 'osv', rule: 'GHSA-x', file: 'yarn.lock', message: 'undici@6: falha' }],
      tools: { osv: { files: 1, now: 1, base: 0 } },
      errors: [],
    });
    await x.worker.handle(x.message, x.channel);
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'SUCCESS',
    );
    expect(x.agents.execute).toHaveBeenCalledTimes(1);
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain(
      '`osv` (informativo) GHSA-x',
    );
  });
  test('non-blocking checks only report', async () => {
    const x = await setup();
    withChecks(x, false);
    x.checks.run.mockResolvedValue(found);
    await x.worker.handle(x.message, x.channel);
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'SUCCESS',
    );
    expect(x.agents.execute).toHaveBeenCalledTimes(1);
    expect(x.github.ensurePullRequest.mock.calls[0][1].body).toContain(
      '1 achado(s) introduzido(s) pela mudança (não bloqueante)',
    );
  });
});
describe('decisions', () => {
  const asking = (questions: string) => ({
    success: true,
    stdout: '{}',
    stderr: '',
    exitCode: 0,
    message: `Não dá para decidir sozinho.\n<duvidas>${questions}</duvidas>`,
  });
  const decisions = () => db.getRepository(Decision).find({ order: { createdAt: 'ASC' } });
  test('a question pauses the task: no commit, no attempt spent, an open decision', async () => {
    const x = await setup();
    x.agents.execute.mockResolvedValue(
      asking(
        '<pergunta>Motivo obrigatório?<opcoes><opcao>Sim</opcao><opcao>Não</opcao></opcoes></pergunta>',
      ),
    );
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task).toMatchObject({ status: 'WAITING', stage: 'WAITING_INPUT', attempts: 0 });
    expect(x.git.commit).not.toHaveBeenCalled();
    expect(x.git.push).not.toHaveBeenCalled();
    // Partial edits are discarded: back to the base commit after the agent asked.
    expect(x.git.resetTo).toHaveBeenLastCalledWith(expect.anything(), 'a'.repeat(40));
    expect(await decisions()).toMatchObject([
      {
        type: 'question',
        status: 'open',
        tenantId: 'acme',
        taskId: x.task.id,
        revisionId: null,
        questions: [{ text: 'Motivo obrigatório?', options: ['Sim', 'Não'] }],
      },
    ]);
    // No tracker comment for questions.
    expect(x.reporter.report).not.toHaveBeenCalled();
    // The agent was told how to ask.
    expect(x.agents.execute.mock.calls[0][1].prompt).toContain('<duvidas>');
  });
  test('the answer resumes the task and reaches every later prompt', async () => {
    const x = await setup();
    x.agents.execute.mockResolvedValueOnce(asking('<pergunta>Motivo obrigatório?</pergunta>'));
    await x.worker.handle(x.message, x.channel);
    const [question] = await decisions();
    await x.orchestrator.answerDecision('acme', question.id, { answers: ['Sim'] }, 'api');
    x.agents.execute.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('SUCCESS');
    const prompt: string = x.agents.execute.mock.calls.at(-1)![1].prompt;
    expect(prompt).toContain('Esclarecimentos do operador');
    expect(prompt).toContain('- Pergunta: Motivo obrigatório?\n  Resposta: Sim');
  });
  test('an answer survives another writer replacing the issue meta (e.g. the Jira poller)', async () => {
    const x = await setup();
    x.agents.execute.mockResolvedValueOnce(asking('<pergunta>Motivo obrigatório?</pergunta>'));
    await x.worker.handle(x.message, x.channel);
    const [question] = await decisions();
    await x.orchestrator.answerDecision('acme', question.id, { answers: ['Sim'] }, 'api');
    // The poller writes meta from a copy it loaded before the answer.
    await db.getRepository(Issue).update(x.task.issueId, { meta: { lastCommentId: '9' } });
    x.agents.execute.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 });
    await x.worker.handle(x.message, x.channel);
    const prompt: string = x.agents.execute.mock.calls.at(-1)![1].prompt;
    expect(prompt).toContain('- Pergunta: Motivo obrigatório?\n  Resposta: Sim');
  });
  test('a stale queue message for a waiting task does nothing', async () => {
    const x = await setup();
    x.agents.execute.mockResolvedValue(asking('<pergunta>Qual tela?</pergunta>'));
    await x.worker.handle(x.message, x.channel);
    x.agents.execute.mockClear();
    await x.worker.handle(x.message, x.channel);
    expect(x.agents.execute).not.toHaveBeenCalled();
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'WAITING',
    );
  });
  test('after 3 rounds of questions, the 4th becomes a failure of the card', async () => {
    const x = await setup();
    x.agents.execute.mockResolvedValue(asking('<pergunta>Qual tela?</pergunta>'));
    for (let round = 0; round < 3; round++) {
      await x.worker.handle(x.message, x.channel);
      const open = (await decisions()).find((d) => d.status === 'open')!;
      await x.orchestrator.answerDecision('acme', open.id, { answers: ['a de perfil'] }, 'api');
    }
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('FAILED');
    expect(task.error).toContain('Card ambíguo demais');
    const last = (await decisions()).at(-1)!;
    expect(last).toMatchObject({ type: 'failure', status: 'open' });
    expect(last.reason).toContain('Card ambíguo demais');
  });
  test('a final failure keeps FAILED, is reported as today and opens a failure decision', async () => {
    const x = await setup();
    x.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
    await x.worker.handle(x.message, x.channel);
    const task = await db.getRepository(Task).findOneByOrFail({ id: x.task.id });
    expect(task.status).toBe('FAILED');
    expect(x.reporter.report).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'failed' }),
    );
    const [failure] = await decisions();
    expect(failure).toMatchObject({ type: 'failure', status: 'open', taskId: x.task.id });
    expect(failure.reason).toMatch(/^TESTS: Tests failed/);
    expect(failure.details).toContain('boom');
  });
  test('a question on a revision points to the revision; the task keeps its PR', async () => {
    const x = await setup();
    await x.worker.handle(x.message, x.channel);
    const revision = await x.orchestrator.requestRevision(
      'acme',
      { taskId: x.task.id },
      { instructions: 'Ajuste a mensagem', origin: 'api' },
    );
    x.agents.execute.mockResolvedValue(asking('<pergunta>Qual mensagem?</pergunta>'));
    await x.worker.handle(revisionMessage(x.task, revision.id), x.channel);
    expect(await db.getRepository(Revision).findOneByOrFail({ id: revision.id })).toMatchObject({
      status: 'WAITING',
      stage: 'WAITING_INPUT',
    });
    expect((await db.getRepository(Task).findOneByOrFail({ id: x.task.id })).status).toBe(
      'SUCCESS',
    );
    expect(await decisions()).toMatchObject([{ type: 'question', revisionId: revision.id }]);
  });
});
describe('telegram notifications', () => {
  const on = () =>
    jest.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_CHAT_ID: '123456789',
      TELEGRAM_NOTIFY_PR: true,
    });
  afterEach(() => jest.restoreAllMocks());
  const notifications = () => db.getRepository(Notification).find({ order: { createdAt: 'ASC' } });
  test('a question decision is queued for Telegram, with secrets redacted', async () => {
    on();
    const x = await setup();
    x.agents.execute.mockResolvedValue({
      success: true,
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      message:
        '<duvidas><pergunta>Usar o token ghp_abcdefghijklmnopqrstuvwxyz0123456789?</pergunta></duvidas>',
    });
    await x.worker.handle(x.message, x.channel);
    const [decision] = await db.getRepository(Decision).find();
    expect(decision.questions![0].text).toContain('[REDACTED]');
    expect(decision.questions![0].text).not.toContain('ghp_');
    expect(await notifications()).toMatchObject([
      { kind: 'decision', decisionId: decision.id, status: 'pending', attempts: 0 },
    ]);
  });
  test('a failure decision is queued too', async () => {
    on();
    const x = await setup();
    x.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
    await x.worker.handle(x.message, x.channel);
    const [decision] = await db.getRepository(Decision).find();
    expect(await notifications()).toMatchObject([{ kind: 'decision', decisionId: decision.id }]);
  });
  test('an opened PR is queued', async () => {
    on();
    const x = await setup();
    await x.worker.handle(x.message, x.channel);
    expect(await notifications()).toMatchObject([
      {
        kind: 'pr',
        payload: {
          tenantId: 'acme',
          taskId: x.task.id,
          card: '#7',
          title: 'Add greeting',
          prUrl: 'https://github.com/example/demo/pull/8',
        },
      },
    ]);
  });
  test('nothing is queued while Telegram is off', async () => {
    const x = await setup();
    x.sandbox.run.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1 });
    await x.worker.handle(x.message, x.channel);
    expect(await notifications()).toEqual([]);
  });
});
