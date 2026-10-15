import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { AgentRouter } from '../src/agents/agent-router.service';
import { Decision, Task } from '../src/database/entities';
import { TaskError } from '../src/config';
import { NeedsInput } from '../src/tasks/decisions';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const CARD =
  'Objetivo\n\nRecusar indicação.\n\nCritérios de aceite\n\nBack-end\n\n1. Endpoint de recusa.\n\nFront-end (perf/stakeholders.html)\n\n- Botão Reprovar com modal.\n\nCenários de teste\n\nCenário 1: recusa';
async function setup({ body = CARD, frontend = true, delivery = undefined as any } = {}) {
  const registry = new TenantRegistry();
  const orchestrator = new OrchestratorService(db, registry);
  const task = await orchestrator.accept('acme', {
    ...item,
    body,
    ...(delivery ? { delivery } : {}),
  });
  let head = 'a'.repeat(40);
  let commits = 0;
  const git = {
    prepare: jest.fn(),
    git: jest.fn(async (_t: unknown, args: string[]) => (args[0] === 'rev-parse' ? head : '')),
    validateChanges: jest.fn().mockResolvedValue({ files: ['src/x.ts'], diff: '1 file changed' }),
    commit: jest.fn(async (_t: unknown, _message: string) => (head = String(++commits).repeat(40))),
    push: jest.fn(),
    resetTo: jest.fn(async (_t: unknown, sha: string) => {
      head = sha;
    }),
    changedPaths: jest.fn(async () => ({ tracked: [], untracked: [] })),
    changedSince: jest.fn(async () => ['src/x.ts', 'views/x.html']),
    revertSideEffects: jest.fn(async () => [] as string[]),
    remoteBranchExists: jest.fn(async () => false),
    diff: jest.fn(async () => ({ text: 'diff', untracked: [] })),
    ensureRemoteBranch: jest.fn(async () => true),
  };
  const agents = {
    execute: jest.fn().mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      message: 'Feito.',
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
  const design = {
    prepare: jest.fn(async () => ({
      source: 'figma' as const,
      files: [{ name: 'figma/index.md', contentType: 'text/markdown', size: 10 }],
      note: 'Leia figma/index.md.',
    })),
  };
  const project = registry.project.bind(registry);
  jest.spyOn(registry, 'project').mockImplementation((t, id) => {
    const ctx = project(t, id);
    const roles = frontend
      ? { ...ctx.tenant.ai.roles, frontend: [{ credential: 'openai-main' }] }
      : ctx.tenant.ai.roles;
    return { ...ctx, host, tenant: { ...ctx.tenant, ai: { ...ctx.tenant.ai, roles } } } as any;
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
    design as any,
  );
  const message = {
    content: Buffer.from(JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'CODE' })),
  } as any;
  const channel = { ack: jest.fn(), nack: jest.fn() } as any;
  return {
    task,
    reporter,
    orchestrator,
    git,
    agents,
    host,
    design,
    worker,
    run: () => worker.handle(message, channel),
  };
}
const reload = (id: string) => db.getRepository(Task).findOneByOrFail({ id });
const roles = (agents: { execute: jest.Mock }) => agents.execute.mock.calls.map((c) => c[1].role);
const prompts = (agents: { execute: jest.Mock }) =>
  agents.execute.mock.calls.map((c) => c[1].prompt as string);
test('design, back by the coder, front by the frontend role: two commits, one PR', async () => {
  const x = await setup();
  await x.run();
  const task = await reload(x.task.id);
  expect(task.status).toBe('SUCCESS');
  expect(roles(x.agents)).toEqual(['coder', 'frontend']);
  expect(x.agents.execute.mock.calls[1][0]).toBe('codex');
  expect(x.git.commit.mock.calls.map((c) => c[1])).toEqual([
    'feat(ai): implement #7 (back-end)',
    'feat(ai): implement #7 (front-end)',
  ]);
  expect(x.host.ensurePullRequest).toHaveBeenCalledTimes(1);
  expect(x.design.prepare).toHaveBeenCalledTimes(1);
  // The project's hidden files reach the workspace preparation.
  expect(x.git.prepare.mock.calls[0][3]).toMatchObject({ hidden: [] });
  // The back is told to leave the Front-end section; the front gets it as its scope + the design.
  const [back, front] = prompts(x.agents);
  expect(back).toContain('EXCETO a seção "Front-end"');
  expect(front).toContain('- Botão Reprovar com modal.');
  expect(front).toContain('Leia figma/index.md.');
  expect(
    x.agents.execute.mock.calls[1][1].attachments.files.map((f: { name: string }) => f.name),
  ).toContain('figma/index.md');
  // The reviewer and the PR see the whole change, not only the front commit.
  expect(task.result!.changes).toMatchObject({ files: ['src/x.ts', 'views/x.html'] });
});
test('missing design stops before any AI is spent', async () => {
  const x = await setup();
  x.design.prepare.mockRejectedValueOnce(new NeedsInput([{ text: 'Sem design?' }]));
  await x.run();
  const task = await reload(x.task.id);
  expect(task.status).toBe('WAITING');
  expect(x.agents.execute).not.toHaveBeenCalled();
  expect(await db.getRepository(Decision).findOneByOrFail({ taskId: x.task.id })).toMatchObject({
    type: 'question',
    questions: [{ text: 'Sem design?' }],
  });
});
test('a back without changes makes no empty commit (focus 4)', async () => {
  const x = await setup();
  // Nothing after the back agent, nor when its commit is attempted; the front then changes files.
  const none = new TaskError('NO_CHANGES: agent produced no changes');
  x.git.validateChanges.mockRejectedValueOnce(none).mockRejectedValueOnce(none);
  await x.run();
  expect((await reload(x.task.id)).status).toBe('SUCCESS');
  expect(x.git.commit.mock.calls.map((c) => c[1])).toEqual(['feat(ai): implement #7 (front-end)']);
});
test('resumed with the back committed: only the front runs (focus 1)', async () => {
  const x = await setup();
  const task = await reload(x.task.id);
  task.status = 'RUNNING';
  task.attempts = 1;
  task.result = { baseSha: 'a'.repeat(40), backSha: 'f'.repeat(40), message: 'Back pronto.' };
  await db.getRepository(Task).save(task);
  x.git.git.mockImplementation(async (_t: unknown, args: string[]) =>
    args[0] === 'rev-parse' ? 'f'.repeat(40) : '',
  );
  await x.run();
  expect(roles(x.agents)).toEqual(['frontend']);
  expect(prompts(x.agents)[0]).toContain('Back pronto.');
});
test('without the frontend role, or without a Front-end section, nothing changes', async () => {
  for (const options of [{ frontend: false }, { body: 'Ajustar o texto do botão.' }]) {
    await db.getRepository(Decision).clear();
    const x = await setup(options);
    await x.run();
    expect(roles(x.agents)).toEqual(['coder']);
    expect(x.design.prepare).not.toHaveBeenCalled();
    expect(x.git.commit.mock.calls.map((c) => c[1])).toEqual(['feat(ai): implement #7']);
    await db.getRepository(Task).clear();
  }
});
test('a crash between the back commit and its checkpoint does not ship a PR without the front (review I1)', async () => {
  const x = await setup();
  const task = await reload(x.task.id);
  task.status = 'RUNNING';
  task.attempts = 1;
  task.result = { baseSha: 'a'.repeat(40), message: 'Back pronto.' };
  await db.getRepository(Task).save(task);
  x.git.git.mockImplementation(async (_t: unknown, args: string[]) =>
    args[0] === 'rev-parse'
      ? 'e'.repeat(40)
      : args[0] === 'log'
        ? 'feat(ai): implement #7 (back-end)'
        : '',
  );
  await x.run();
  expect(roles(x.agents)).toEqual(['frontend']);
  expect(x.git.commit.mock.calls.map((c) => c[1])).toEqual(['feat(ai): implement #7 (front-end)']);
});
test('a screen-only card resumed after a wait does not pay for the coder again (review I2)', async () => {
  const x = await setup();
  const task = await reload(x.task.id);
  task.status = 'PENDING';
  task.result = { baseSha: 'a'.repeat(40), backSha: 'a'.repeat(40) };
  await db.getRepository(Task).save(task);
  await x.run();
  expect(roles(x.agents)).toEqual(['frontend']);
});
test('a front with nothing to change after a real back ships the back (review I4)', async () => {
  const x = await setup();
  const none = new TaskError('NO_CHANGES: agent produced no changes');
  x.git.validateChanges
    .mockResolvedValueOnce({ files: ['src/x.ts'], diff: '' })
    .mockResolvedValueOnce({ files: ['src/x.ts'], diff: '' })
    .mockRejectedValueOnce(none)
    .mockRejectedValueOnce(none);
  await x.run();
  expect((await reload(x.task.id)).status).toBe('SUCCESS');
  expect(x.git.commit.mock.calls.map((c) => c[1])).toEqual(['feat(ai): implement #7 (back-end)']);
  expect(x.git.push.mock.calls[0][1]).toBe('1'.repeat(40));
});
test('a sub-task started on its own does not queue the next one nor close the story', async () => {
  const step = {
    externalId: '123',
    key: '#7',
    title: 'Tela',
    body: CARD,
    revisionId: 'r',
    attachments: [],
  };
  const x = await setup({
    delivery: {
      baseRef: 'feature/PF-24377',
      prTarget: 'feature/PF-23986',
      single: true,
      stepIndex: 0,
      story: {
        key: 'PF-23986',
        externalId: '9',
        title: 'História',
        body: 'contexto',
        branch: 'feature/PF-23986',
        steps: [step, { ...step, key: 'PF-99' }],
      },
    },
  });
  const next = jest.spyOn(x.orchestrator, 'nextStackedStep');
  await x.run();
  expect((await reload(x.task.id)).status).toBe('SUCCESS');
  expect(next).not.toHaveBeenCalled();
  const events = x.reporter.report.mock.calls.map((c) => c[2].type);
  expect(events).toContain('pr');
  expect(events).not.toContain('story-done');
});
