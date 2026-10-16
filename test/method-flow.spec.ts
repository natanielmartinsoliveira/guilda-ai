import { EXAMPLE_METHOD, METHOD_PACK, methodRun } from './fixtures/method-ws';
import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { AgentRouter } from '../src/agents/agent-router.service';
import { Decision, Task } from '../src/database/entities';
import { authorization, authorizationFor } from './fixtures/method-ws';
import { config } from '../src/config';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
  jest.restoreAllMocks();
});
const CODER = {
  type: 'coder' as const,
  url: 'https://coder.example.com',
  name: 'ws',
  root: '/root/ai',
  reference: '/workspaces/svc',
  protect: ['/workspaces'],
};
const SPEC = 'docs/spec';
type Route = 'feature' | 'screen' | 'fix' | 'adopt' | 'cleanup' | 'direct';
type Script = {
  analyse?: string[];
  deliver?: string[];
  /** Files the analysis leaves uncommitted. */
  analyseWrites?: string[];
  /** Files the delivery leaves uncommitted (none: the method's agent commits its own work). */
  deliverLeaves?: string[];
  config?: Record<string, unknown>;
};
async function setup(route: Route, script: Script = {}) {
  const registry = new TenantRegistry();
  const orchestrator = new OrchestratorService(db, registry);
  const task = await orchestrator.accept('acme', { ...item, delivery: { route } as any });
  let head = 'a'.repeat(40);
  // The task folder's uncommitted files, as git status would list them.
  let tree: string[] = [];
  const git = {
    prepare: jest.fn(),
    git: jest.fn(async (_t: unknown, args: string[]) => {
      if (args[0] === 'rev-parse') return head;
      if (args[0] === 'status') return tree.map((p) => `?? ${p}\0`).join('');
      if (args[0] === 'clean' || args[0] === 'checkout') tree = [];
      return '';
    }),
    validateChanges: jest.fn().mockResolvedValue({ files: ['src/x.php'], diff: '1 file' }),
    commit: jest.fn(),
    commitPaths: jest.fn(
      async (_t: unknown, _paths: string[], _message: string, _author: unknown) => {
        tree = [];
        return (head = 'c'.repeat(40));
      },
    ),
    push: jest.fn(),
    resetTo: jest.fn(),
    changedPaths: jest.fn(async () => ({ tracked: [], untracked: [] })),
    changedSince: jest.fn(async () => [`${SPEC}/rules/desconto.md`, 'src/x.php']),
    revertSideEffects: jest.fn(async () => [] as string[]),
    remoteBranchExists: jest.fn(async () => false),
    diff: jest.fn(),
    fetchBranch: jest.fn(),
  };
  const analyse = [...(script.analyse ?? ['<resultado>concluido</resultado>'])];
  const deliver = [...(script.deliver ?? ['<resultado>concluido</resultado>'])];
  const agents = {
    execute: jest.fn(async (_p: string, input: { prompt: string }) => {
      const analysing = input.prompt.startsWith('Write the specification');
      if (analysing) tree = script.analyseWrites ?? [`${SPEC}/rules/desconto.md`];
      else tree = script.deliverLeaves ?? [];
      return {
        success: true,
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        message: analysing ? analyse.shift() : deliver.shift(),
      };
    }),
  };
  const ws = {
    kind: 'coder',
    root: '/root/ai',
    label: 'ws:/root/ai/t',
    attachmentsPath: '/root/ai/t/.ai-dev-team/attachments',
    run: methodRun(() => script.config ?? { spec_root: SPEC }),
    upload: jest.fn(),
    remove: jest.fn(),
  };
  const host = {
    id: 'gl',
    cloneUrl: () => 'ssh://git/x.git',
    gitAuthHeader: () => '',
    ensurePullRequest: jest.fn(),
    commentOnPullRequest: jest.fn(),
  };
  const project = registry.project.bind(registry);
  jest.spyOn(registry, 'project').mockImplementation((t, id) => {
    const ctx = project(t, id);
    return {
      ...ctx,
      host,
      tenant: {
        ...ctx.tenant,
        packDir: METHOD_PACK,
        ai: {
          ...ctx.tenant.ai,
          roles: { ...ctx.tenant.ai.roles, reviewer: [{ credential: 'openai-main' }] },
        },
      },
      project: {
        ...ctx.project,
        workspace: CODER,
        delivery: 'rehearsal',
        method: EXAMPLE_METHOD,
      },
    } as any;
  });
  const worker = new TaskWorkerService(
    db,
    {} as any,
    new AgentRouter(db, agents as any),
    {} as any,
    git as any,
    registry,
    { report: jest.fn() } as any,
    { run: jest.fn() } as any,
    orchestrator,
    { run: jest.fn() } as any,
    { prepare: jest.fn() } as any,
    { bind: () => ws, of: () => ws } as any,
  );
  const run = () =>
    worker.handle(
      {
        content: Buffer.from(
          JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'CODE' }),
        ),
      } as any,
      { ack: jest.fn(), nack: jest.fn() } as any,
    );
  const answerOpen = async (answer: string) => {
    const open = await db
      .getRepository(Decision)
      .findOneByOrFail({ taskId: task.id, status: 'open' });
    await orchestrator.answerDecision('acme', open.id, { answers: [answer] }, 'web');
    return open;
  };
  const open = () =>
    db.getRepository(Decision).findOneByOrFail({ taskId: task.id, status: 'open' });
  const reload = () => db.getRepository(Task).findOneByOrFail({ id: task.id });
  const reviseRun = (revisionId: string) =>
    worker.handle(
      {
        content: Buffer.from(
          JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'REVISE', revisionId }),
        ),
      } as any,
      { ack: jest.fn(), nack: jest.fn() } as any,
    );
  const prompts = () =>
    agents.execute.mock.calls.map(
      (c) =>
        c[1] as { prompt: string; role: string; timeoutMs: number; env?: Record<string, string> },
    );
  return { task, git, ws, run, answerOpen, open, reload, prompts, host, reviseRun };
}
test('feature: the specification step leaves the specification for review; adjust discards it; approval commits only its root', async () => {
  const x = await setup('feature', {
    analyse: ['<resultado>concluido</resultado>', '<resultado>concluido</resultado>'],
    deliver: [
      '<resultado>parado</resultado><pendencias>Decide the field name</pendencias><opcoes>\n- Use valid_until (recomendado)\n- Use expires_at\n</opcoes>',
      '<resultado>concluido</resultado>',
    ],
  });
  await x.run();
  let task = await x.reload();
  expect(task.status).toBe('WAITING');
  expect(x.prompts()[0].prompt.startsWith('Write the specification')).toBe(true);
  expect(x.prompts()[0].prompt).toContain(item.title);
  // nothing committed before the person reviews it
  expect(x.git.commitPaths).not.toHaveBeenCalled();
  expect(x.git.commit).not.toHaveBeenCalled();
  const gate = await x.answerOpen('include the business customer case');
  expect(gate.questions![0].text).toContain(`${SPEC}/rules/desconto.md`);
  expect(gate.questions![0].options).toEqual([authorization(x.task.branch, true)]);
  await x.run();
  // the rejected analysis is discarded (only the specification root) before analysing again
  expect(x.git.git.mock.calls.some(([, a]) => a[0] === 'clean' && a.includes(SPEC))).toBe(true);
  expect(x.prompts()[1].prompt.startsWith('Write the specification')).toBe(true);
  expect(x.prompts()[1].prompt).toContain('include the business customer case');
  await x.answerOpen(authorization(x.task.branch, true));
  await x.run();
  // the approval commits the specification root alone, under the method's message
  expect(x.git.commitPaths).toHaveBeenCalledTimes(1);
  expect(x.git.commitPaths.mock.calls[0]).toEqual([
    expect.objectContaining({ id: x.task.id }),
    [SPEC],
    `spec ${x.task.branch}`,
    expect.objectContaining({ name: expect.any(String) }),
  ]);
  // The method's agent gets what the method declares (dirs it may read, tools it may run).
  expect(x.prompts()[0]).toMatchObject({
    addDirs: ['~/.method-tools'],
    allowedTools: ['Bash(python3 -B:*)', 'Bash(git status:*)'],
  });
  const deliver = x.prompts()[2];
  expect(deliver.prompt.startsWith('Deliver the scope')).toBe(true);
  expect(deliver.prompt).toContain(`«${authorization(x.task.branch, true)}»`);
  expect(deliver.timeoutMs).toBe(240 * 60000);
  expect(deliver.env).toMatchObject({
    GIT_AUTHOR_NAME: expect.any(String),
    GIT_COMMITTER_EMAIL: expect.any(String),
    PYTHONPATH: '/workspaces/.ai-dev-team/pylib',
  });
  const stop = await x.answerOpen('use valid_until');
  expect(stop.questions![0].text).toContain('Decide the field name');
  // the agent's choices become the decision's options (else the method's single stop option)
  expect(stop.questions![0].options).toEqual(['Use valid_until (recomendado)', 'Use expires_at']);
  await x.run();
  expect(x.prompts()[3].prompt).toContain('use valid_until');
  task = await x.reload();
  expect(task.status).toBe('SUCCESS');
  expect(task.stage).toBe('REHEARSED');
  expect(x.git.commit).not.toHaveBeenCalled();
  expect(x.git.push).not.toHaveBeenCalled();
  expect(x.host.ensurePullRequest).not.toHaveBeenCalled();
  expect(x.prompts().map((p) => p.role)).toEqual(['coder', 'coder', 'coder', 'coder']);
  expect(x.ws.run).toHaveBeenCalledWith(
    ['npm', 'test'],
    expect.objectContaining({ agent: 'tester' }),
  );
  // The finished rehearsal advances the accumulated specification: the method's advance hook.
  expect(
    x.ws.run.mock.calls.some(
      ([argv]) => argv[0] === 'python3' && argv[1] === '.ai-dev-team/method/hooks/advance.py',
    ),
  ).toBe(true);
  expect(task.result!.rehearsal).toMatchObject({
    files: [`${SPEC}/rules/desconto.md`, 'src/x.php'],
  });
});
test('a specification step that writes outside the specification root is a stop, never a commit', async () => {
  const x = await setup('feature', { analyseWrites: [`${SPEC}/a.md`, 'app/Models/X.php'] });
  await x.run();
  const question = (await x.open()).questions![0].text;
  expect(question).toContain('app/Models/X.php');
  expect(question).toContain('outside the specification root');
  expect(x.git.commitPaths).not.toHaveBeenCalled();
});
test('a delivery that leaves files uncommitted fails, listing them; the AI Dev Team commits nothing', async () => {
  const x = await setup('screen', { deliverLeaves: ['app/Leftover.php'] });
  await x.run();
  await x.answerOpen(authorization(x.task.branch));
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('FAILED');
  expect(task.error).toContain('app/Leftover.php');
  expect(x.git.commit).not.toHaveBeenCalled();
  expect(x.git.commitPaths).not.toHaveBeenCalled();
});
test('a review-gate.json without spec_root stops clearly (focus 3)', async () => {
  const x = await setup('feature', { config: {} });
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('FAILED');
  expect(task.error).toMatch(/spec_root/);
});
test('screen goes straight to the gate; fix delivers as a corrective increment', async () => {
  const surface = await setup('screen');
  await surface.run();
  expect(surface.prompts()).toHaveLength(0);
  expect((await surface.reload()).status).toBe('WAITING');
  expect((await surface.open()).questions![0].options).toEqual([
    authorization(surface.task.branch),
  ]);
  await db.destroy();
  db = await database();
  const corrective = await setup('fix');
  await corrective.run();
  await corrective.answerOpen(authorization(corrective.task.branch));
  await corrective.run();
  expect(corrective.prompts()[0].prompt).toContain('corrective increment');
  expect((await corrective.reload()).status).toBe('SUCCESS');
});
test('gates and stops never exhaust the question rounds', async () => {
  const x = await setup('screen');
  for (let i = 0; i < 5; i++) {
    await x.run();
    await x.answerOpen(`ajuste ${i}`);
  }
  await x.run();
  expect((await x.reload()).status).toBe('WAITING');
});
test('a missing result mark is a stop, never a delivery', async () => {
  const x = await setup('screen', { deliver: ['Terminei.'] });
  await x.run();
  await x.answerOpen(authorization(x.task.branch));
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('WAITING');
  expect((await x.open()).questions![0].text).toContain('Terminei.');
});
test('a method that refuses revisions never patches a task: the fix route is a new task', async () => {
  const x = await setup('screen');
  await x.run();
  await x.answerOpen(authorization(x.task.branch));
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('SUCCESS');
  const { Revision } = await import('../src/database/entities');
  const revision = await db.getRepository(Revision).save({
    taskId: task.id,
    number: 1,
    instructions: 'muda x',
    origin: 'api',
    status: 'PENDING',
    attempts: 0,
    stage: 'QUEUED',
  } as any);
  await x.reviseRun(revision.id);
  const saved = await db.getRepository(Revision).findOneByOrFail({ id: revision.id });
  expect(saved.status).toBe('FAILED');
  expect(saved.error).toMatch(/"fix" route/);
});

test('adopt: the gate authorizes the context; the adopt prompt gets the words and the ask; no project tests', async () => {
  const x = await setup('adopt', { deliverLeaves: [] });
  await x.run();
  const gate = (await x.open()).questions![0];
  expect(gate.options).toEqual([authorizationFor('adopt', x.task.branch)]);
  expect(gate.options![0]).toMatch(/^Adopt the context/);
  await x.answerOpen(authorizationFor('adopt', x.task.branch));
  await x.run();
  const prompt = x.prompts()[0].prompt;
  expect(prompt.startsWith('Adopt the existing code')).toBe(true);
  expect(prompt).toContain(`«${authorizationFor('adopt', x.task.branch)}»`);
  expect(prompt).toContain(item.title);
  expect(x.ws.run).not.toHaveBeenCalledWith(['npm', 'test'], expect.anything());
  expect((await x.reload()).status).toBe('SUCCESS');
});
test('cleanup: remove only comments of the listed files, commit them by pathspec', async () => {
  const x = await setup('cleanup', { deliverLeaves: ['app/Order.php', 'docs/trace.json'] });
  await x.run();
  await x.answerOpen(authorizationFor('cleanup', x.task.branch));
  await x.run();
  const prompt = x.prompts()[0].prompt;
  expect(prompt.startsWith('Comment cleanup')).toBe(true);
  expect(prompt).toMatch(/removal, never/);
  expect(x.git.commitPaths.mock.calls[0].slice(1, 3)).toEqual([
    ['app/Order.php', 'docs/trace.json'],
    `cleanup ${x.task.branch}`,
  ]);
  expect(x.ws.run).toHaveBeenCalledWith(['npm', 'test'], expect.anything());
  expect((await x.reload()).status).toBe('SUCCESS');
});
test('cleanup with nothing changed fails without an empty commit (focus 4)', async () => {
  const x = await setup('cleanup', { deliverLeaves: [] });
  await x.run();
  await x.answerOpen(authorizationFor('cleanup', x.task.branch));
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('FAILED');
  expect(task.error).toMatch(/NO_CHANGES/);
  expect(x.git.commitPaths).not.toHaveBeenCalled();
});
test('direct: refused unless the project allowed direct edits (focus 5)', async () => {
  const none = await setup('direct');
  await none.run();
  let task = await none.reload();
  expect(task.status).toBe('FAILED');
  expect(task.error).toMatch(/direct_edits/);
  await db.destroy();
  db = await database();
  const two = await setup('direct', {
    config: { spec_root: SPEC, direct_edits: 'yes' },
  });
  await two.run();
  task = await two.reload();
  expect(task.status).toBe('FAILED');
  expect(task.error).toMatch(/direct_edits/);
});
test('direct with direct edits: the core flow, the surface rule in the prompt, a pathspec commit', async () => {
  const x = await setup('direct', {
    config: { spec_root: SPEC, direct_edits: true },
  });
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('SUCCESS');
  const coder = x.prompts().find((p) => p.role === 'coder')!.prompt;
  expect(coder).toMatch(/surface only/);
  expect(x.git.commit).not.toHaveBeenCalled();
  expect(x.git.commitPaths.mock.calls[0][1]).toEqual(['src/x.php']);
});
describe('a plain approval at the gate counts as its option (the option text is what is quoted)', () => {
  test.each(['ok', 'Aprovado!', 'pode seguir', '  SIM. ', '👍', '1', 'approved'])(
    '"%s" authorizes',
    async (answer) => {
      const x = await setup('screen');
      await x.run();
      await x.answerOpen(answer);
      await x.run();
      expect((await x.reload()).status).toBe('SUCCESS');
      expect(x.prompts()[0].prompt).toContain(`«${authorization(x.task.branch)}»`);
      expect(x.prompts()[0].prompt).not.toContain(`«${answer}»`);
    },
  );
  test('anything more than an approval is an adjustment, never an authorization', async () => {
    const x = await setup('screen');
    await x.run();
    await x.answerOpen('ok, mas mude o nome do campo');
    await x.run();
    expect(x.prompts()).toHaveLength(0);
    expect((await x.reload()).status).toBe('WAITING');
  });
});
