import { DataSource } from 'typeorm';
import { database, item } from './db';
import { AgentRouter } from '../src/agents/agent-router.service';
import { Decision, Task } from '../src/database/entities';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { findTenant, loadTenants } from '../src/tenants/tenants';
import { NeedsInput } from '../src/tasks/decisions';
import { CODER_PROJECT, coderTenantYaml } from './fixtures/coder-tenant';

let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const ok = (costUsd?: number) => ({
  success: true,
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  ...(costUsd === undefined ? {} : { costUsd }),
});
async function task() {
  return new OrchestratorService(db, new TenantRegistry()).accept('acme', item);
}
const withBudget = (perTaskUsd: number) => {
  const tenant = findTenant('acme')!;
  return { ...tenant, ai: { ...tenant.ai, budget: { perTaskUsd } } };
};
const cost = async (id: string) =>
  Number((await db.getRepository(Task).findOneByOrFail({ id })).costUsd);

test('each run adds what it cost to the task, also across runs; unknown cost adds nothing', async () => {
  const t = await task();
  const agents = {
    execute: jest
      .fn()
      .mockResolvedValueOnce(ok(1.25))
      .mockResolvedValueOnce(ok(0.5))
      .mockResolvedValue(ok()),
  };
  const router = new AgentRouter(db, agents as never);
  const input = { taskId: t.id, tenantId: 'acme', workspace: '/w', prompt: 'p' };
  const first = await router.run(findTenant('acme')!, 'coder', input, jest.fn());
  expect(first.attempts[0].costUsd).toBe(1.25);
  await router.run(findTenant('acme')!, 'coder', input, jest.fn());
  await router.run(findTenant('acme')!, 'coder', input, jest.fn());
  expect(await cost(t.id)).toBeCloseTo(1.75);
});

test('at the budget a run does not start: the task asks to release more', async () => {
  const t = await task();
  await db.getRepository(Task).update(t.id, { costUsd: 2.1 } as never);
  const agents = { execute: jest.fn().mockResolvedValue(ok(1)) };
  const router = new AgentRouter(db, agents as never);
  const input = { taskId: t.id, tenantId: 'acme', workspace: '/w', prompt: 'p' };
  const error = await router.run(withBudget(2), 'coder', input, jest.fn()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NeedsInput);
  const question = (error as NeedsInput).questions[0];
  expect(question.text).toMatch(/^💰/);
  expect(question.text).toContain('2.10');
  expect(question.options).toHaveLength(1);
  expect(agents.execute).not.toHaveBeenCalled();
});

test('releasing (the option or a plain approval) raises the budget by one more share; anything else keeps it', async () => {
  const t = await task();
  await db.getRepository(Task).update(t.id, { costUsd: 2.1 } as never);
  const agents = { execute: jest.fn().mockResolvedValue(ok(1)) };
  const router = new AgentRouter(db, agents as never);
  const input = { taskId: t.id, tenantId: 'acme', workspace: '/w', prompt: 'p' };
  const asked = (await router
    .run(withBudget(2), 'coder', input, jest.fn())
    .catch((e) => e)) as NeedsInput;
  const answer = async (text: string) =>
    db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId: t.id,
      revisionId: null,
      type: 'question',
      status: 'answered',
      questions: asked.questions,
      answer: { answers: [text] },
      answeredAt: new Date(),
    });
  await answer('não, espera');
  await expect(router.run(withBudget(2), 'coder', input, jest.fn())).rejects.toBeInstanceOf(
    NeedsInput,
  );
  await answer('ok');
  await router.run(withBudget(2), 'coder', input, jest.fn());
  expect(agents.execute).toHaveBeenCalledTimes(1);
});

test('without a budget nothing ever waits on cost', async () => {
  const t = await task();
  await db.getRepository(Task).update(t.id, { costUsd: 999 } as never);
  const agents = { execute: jest.fn().mockResolvedValue(ok(1)) };
  await new AgentRouter(db, agents as never).run(
    findTenant('acme')!,
    'coder',
    { taskId: t.id, tenantId: 'acme', workspace: '/w', prompt: 'p' },
    jest.fn(),
  );
  expect(agents.execute).toHaveBeenCalledTimes(1);
});

test('ai.budget.perTaskUsd is a positive number', () => {
  const yaml = (budget: string) =>
    coderTenantYaml(CODER_PROJECT).replace(
      '      providers: [claude]',
      `      providers: [claude]\n      budget: ${budget}`,
    );
  expect(loadTenants(yaml('{ perTaskUsd: 15 }'))[0].ai.budget).toEqual({ perTaskUsd: 15 });
  expect(() => loadTenants(yaml('{ perTaskUsd: 0 }'))).toThrow(/perTaskUsd/);
});
