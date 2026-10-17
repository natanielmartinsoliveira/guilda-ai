import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { AgentRouter } from '../src/agents/agent-router.service';
import { Revision, Task } from '../src/database/entities';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const CODER = {
  type: 'coder' as const,
  url: 'https://coder.example.com',
  name: 'ws',
  root: '/root/ai',
  protect: ['/workspaces'],
};
async function setup({ coder = true, reviewer = false, delivery = 'rehearsal' } = {}) {
  const registry = new TenantRegistry();
  const orchestrator = new OrchestratorService(db, registry);
  const task = await orchestrator.accept('acme', item);
  let head = 'a'.repeat(40);
  const git = {
    prepare: jest.fn(),
    git: jest.fn(async (_t: unknown, args: string[]) => (args[0] === 'rev-parse' ? head : '')),
    validateChanges: jest.fn().mockResolvedValue({ files: ['src/x.ts'], diff: '1 file changed' }),
    commit: jest.fn(async () => (head = 'b'.repeat(40))),
    push: jest.fn(),
    resetTo: jest.fn(async (_t: unknown, sha: string) => {
      head = sha;
    }),
    changedPaths: jest.fn(async () => ({ tracked: [], untracked: ['src/new.ts'] })),
    changedSince: jest.fn(async () => ['src/x.ts']),
    revertSideEffects: jest.fn(async () => [] as string[]),
    remoteBranchExists: jest.fn(async () => false),
    diff: jest.fn(async () => ({ text: 'secret diff', untracked: [] })),
    ensureRemoteBranch: jest.fn(async () => true),
    fetchBranch: jest.fn(),
  };
  const agents = {
    execute: jest.fn().mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      message: '<revisao>\nveredito: aprovado\n</revisao>',
    }),
  };
  const sandbox = {
    run: jest.fn().mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0 }),
  };
  const host = {
    id: 'gh',
    cloneUrl: (r: string) => `https://github.com/${r}.git`,
    gitAuthHeader: () => 'Authorization: Basic test',
    ensurePullRequest: jest.fn().mockResolvedValue({
      id: '1',
      number: 8,
      title: 'AI',
      url: 'https://github.com/example/demo/pull/8',
      state: 'open',
    }),
    commentOnPullRequest: jest.fn(),
  };
  const reporter = { report: jest.fn() };
  const testOutput = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const ws = {
    kind: coder ? 'coder' : 'local',
    label: 'ws:/root/ai/t',
    attachmentsPath: coder ? '/root/ai/t/.ai-dev-team/attachments' : '/attachments',
    run: jest
      .fn()
      .mockResolvedValue({ success: true, exitCode: 0, stdout: testOutput, stderr: '' }),
  };
  const workspaces = { bind: jest.fn(() => ws), of: jest.fn(() => ws) };
  const project = registry.project.bind(registry);
  jest.spyOn(registry, 'project').mockImplementation((t, id) => {
    const ctx = project(t, id);
    const roles = reviewer
      ? { ...ctx.tenant.ai.roles, reviewer: [{ credential: 'openai-main' }] }
      : ctx.tenant.ai.roles;
    return {
      ...ctx,
      host,
      tenant: { ...ctx.tenant, ai: { ...ctx.tenant.ai, roles } },
      project: coder
        ? {
            ...ctx.project,
            workspace: CODER,
            delivery,
            pullRequest: {
              ...ctx.project.pullRequest,
              title: '{key} - {title}',
              reviewers: ['pat.doe'],
            },
          }
        : ctx.project,
    } as any;
  });
  const worker = new TaskWorkerService(
    db,
    {} as any,
    new AgentRouter(db, agents as any),
    sandbox as any,
    git as any,
    registry,
    reporter as any,
    { run: jest.fn() } as any,
    orchestrator,
    { run: jest.fn().mockResolvedValue({ findings: [], tools: {}, errors: [] }) } as any,
    { prepare: jest.fn() } as any,
    workspaces as any,
  );
  const message = {
    content: Buffer.from(JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'CODE' })),
  } as any;
  const channel = { ack: jest.fn(), nack: jest.fn() } as any;
  const revise = async (instructions: string) => {
    const revision = await orchestrator.requestRevision(
      'acme',
      { taskId: task.id },
      { instructions, origin: 'api' },
    );
    await worker.handle(
      {
        content: Buffer.from(
          JSON.stringify({
            taskId: task.id,
            issueId: task.issueId,
            type: 'REVISE',
            revisionId: revision.id,
          }),
        ),
      } as any,
      channel,
    );
    return revision;
  };
  return {
    revise,
    orchestrator,
    task,
    git,
    agents,
    sandbox,
    host,
    reporter,
    ws,
    workspaces,
    run: () => worker.handle(message, channel),
  };
}
const reload = (id: string) => db.getRepository(Task).findOneByOrFail({ id });
test('rehearsal: the whole flow, no push, no PR, ends REHEARSED with where to look', async () => {
  const x = await setup();
  await x.run();
  const task = await reload(x.task.id);
  expect(task.status).toBe('SUCCESS');
  expect(task.stage).toBe('REHEARSED');
  expect(x.git.commit).toHaveBeenCalled();
  expect(x.git.push).not.toHaveBeenCalled();
  expect(x.host.ensurePullRequest).not.toHaveBeenCalled();
  expect(task.result!.rehearsal).toMatchObject({
    workspace: 'ws:/root/ai/t',
    branch: x.task.branch,
    commitSha: 'b'.repeat(40),
    files: ['src/x.ts'],
  });
  expect(task.result!.prUrl).toBeUndefined();
});
test('rehearsal reports only that the delivery is built (no PR, comment or failure event)', async () => {
  const x = await setup();
  await x.run();
  expect(x.reporter.report.mock.calls.map((c: unknown[]) => c[2])).toEqual([{ type: 'built' }]);
});
test('coder: the task is bound to its workspace; tests run there and keep the last 40 lines', async () => {
  const x = await setup();
  await x.run();
  expect(x.workspaces.bind).toHaveBeenCalledWith(expect.objectContaining({ id: x.task.id }), CODER);
  expect(x.ws.run).toHaveBeenCalledWith(
    ['npm', 'test'],
    expect.objectContaining({ agent: 'tester' }),
  );
  expect(x.sandbox.run).not.toHaveBeenCalled();
  const task = await reload(x.task.id);
  const stdout = String((task.result!.validation as { stdout: string }).stdout);
  expect(stdout.split('\n')).toHaveLength(40);
  expect(stdout.endsWith('line 59')).toBe(true);
});
test('coder: the agent gets the workspace; the reviewer reads the diff there, not in the prompt', async () => {
  const x = await setup({ reviewer: true });
  await x.run();
  expect(x.agents.execute.mock.calls[0][1].remote).toBe(x.ws);
  const review = x.agents.execute.mock.calls.find((c) => c[1].readOnly)![1].prompt as string;
  expect(review).toContain('git diff');
  expect(review).not.toContain('secret diff');
  expect(review).toContain('src/new.ts');
  expect(x.git.diff).not.toHaveBeenCalled();
});
test('local projects keep delivering (push + PR) exactly as before', async () => {
  const x = await setup({ coder: false });
  await x.run();
  const task = await reload(x.task.id);
  expect(task.stage).toBe('DONE');
  expect(x.git.push).toHaveBeenCalled();
  expect(x.host.ensurePullRequest).toHaveBeenCalled();
  expect(x.agents.execute.mock.calls[0][1].remote).toBeUndefined();
});

test('coder + draft: push from the workspace and a draft MR with reviewers and the title pattern', async () => {
  const x = await setup({ delivery: 'draft' });
  await x.run();
  const task = await reload(x.task.id);
  expect(task.stage).toBe('DONE');
  expect(x.git.push).toHaveBeenCalled();
  expect(x.host.ensurePullRequest).toHaveBeenCalledWith(
    'example/demo',
    expect.objectContaining({
      draft: true,
      reviewers: ['pat.doe'],
      title: '#7 - Add greeting',
    }),
  );
  expect(task.result!.rehearsal).toBeUndefined();
});
test('coder + normal: the MR is not a draft', async () => {
  const x = await setup({ delivery: 'normal' });
  await x.run();
  expect(x.host.ensurePullRequest.mock.calls[0][1].draft).toBe(false);
});
test('a title with braces in the card title is replaced once (focus 4)', async () => {
  const { prTitle } = await import('../src/tasks/pr-description');
  expect(prTitle('{key} - {title}', 'PF-1', 'Use {key} here')).toBe('PF-1 - Use {key} here');
});

test('a rehearsal can be adjusted: same folder, new local commit, no fetch, push or PR', async () => {
  const x = await setup();
  await x.run();
  const revision = await x.revise('troque o nome da variável');
  const saved = await db.getRepository(Revision).findOneByOrFail({ id: revision.id });
  expect(saved.status).toBe('SUCCESS');
  expect(saved.stage).toBe('REHEARSED');
  expect(x.git.fetchBranch).not.toHaveBeenCalled();
  expect(x.git.push).not.toHaveBeenCalled();
  expect(x.host.ensurePullRequest).not.toHaveBeenCalled();
  expect(x.host.commentOnPullRequest).not.toHaveBeenCalled();
  const task = await reload(x.task.id);
  expect(x.git.commit).toHaveBeenCalledTimes(2);
  expect(task.result!.rehearsal).toMatchObject({ commitSha: saved.result!.commitSha });
  // Only the first run's "built"; an adjustment says nothing to the tracker.
  expect(x.reporter.report.mock.calls.map((c: unknown[]) => c[2])).toEqual([{ type: 'built' }]);
});
test('a discarded rehearsal refuses adjustments (focus 4)', async () => {
  const x = await setup();
  await x.run();
  const task = await reload(x.task.id);
  task.result = {
    ...task.result,
    rehearsal: { ...(task.result!.rehearsal as object), discarded: true },
  };
  await db.getRepository(Task).save(task);
  await expect(x.revise('mais um ajuste')).rejects.toThrow(/descartado/);
});
test('with Telegram on, a finished rehearsal (and its adjustment) is announced', async () => {
  const settings = await import('../src/config');
  jest.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_CHAT_ID: '1',
  });
  const { Notification } = await import('../src/database/entities');
  const x = await setup();
  await x.run();
  await x.revise('ajuste');
  const texts = (await db.getRepository(Notification).findBy({ kind: 'text' })).map(
    (n) => (n.payload as { text: string }).text,
  );
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain('Ensaio concluído — nada foi publicado');
  expect(texts[0]).toContain('ws:/root/ai/t');
  expect(texts[1]).toContain('Ensaio concluído (ajuste #1)');
  jest.restoreAllMocks();
});
