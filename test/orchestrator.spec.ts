import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { clarificationsFrom } from '../src/tasks/decisions';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Task, Issue, Project, Outbox, Decision } from '../src/database/entities';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
test('persists project, issue, task and durable outbox; duplicate webhook is idempotent', async () => {
  const service = new OrchestratorService(db, new TenantRegistry()),
    task = await service.accept('acme', item);
  const duplicate = await service.accept('acme', item);
  expect(duplicate.id).toBe(task.id);
  expect(task.tenantId).toBe('acme');
  expect(task.provider).toBe('codex');
  expect(task.branch).toBe(`ai/task-${task.id}`);
  expect(task.workspace).toBe(`/tmp/ai-dev-team-test-workspaces/acme/${task.id}`);
  for (const entity of [Task, Issue, Project, Outbox])
    expect(await db.getRepository(entity).count()).toBe(1);
});
test('same external id in two tenants creates two isolated tasks with tenant defaults', async () => {
  const service = new OrchestratorService(db, new TenantRegistry());
  const acme = await service.accept('acme', item);
  const globex = await service.accept('globex', { ...item, project: 'site' });
  expect(globex.id).not.toBe(acme.id);
  expect(globex.provider).toBe('claude');
  expect(globex.workspace).toContain('/globex/');
  const projects = await db.getRepository(Project).find({ order: { tenantId: 'ASC' } });
  expect(projects.map((p) => [p.tenantId, p.name])).toEqual([
    ['acme', 'example/demo'],
    ['globex', 'globex/site'],
  ]);
});
test('rejects a project the tenant does not declare', async () => {
  await expect(
    new OrchestratorService(db, new TenantRegistry()).accept('acme', { ...item, project: 'site' }),
  ).rejects.toThrow('Unknown project');
  expect(await db.getRepository(Task).count()).toBe(0);
});
describe('answering decisions', () => {
  /** A task (distinct per externalId) already waiting or failed, with its open decision. */
  async function waiting(type: 'question' | 'failure', externalId = '123') {
    const orchestrator = new OrchestratorService(db, new TenantRegistry());
    const task = await orchestrator.accept('acme', { ...item, externalId });
    await db.getRepository(Task).update(task.id, {
      status: type === 'question' ? 'WAITING' : 'FAILED',
      stage: type === 'question' ? 'WAITING_INPUT' : 'TESTS',
    });
    const decision = await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId: task.id,
      revisionId: null,
      type,
      status: 'open',
      questions:
        type === 'question' ? [{ text: 'Motivo obrigatório?' }, { text: 'Qual tela?' }] : null,
      reason: type === 'failure' ? 'TESTS: Tests failed' : null,
    });
    await db.getRepository(Outbox).clear();
    return { orchestrator, task, decision };
  }
  test('answers to every question become clarifications and the task is queued again', async () => {
    const { orchestrator, task, decision } = await waiting('question');
    await orchestrator.answerDecision('acme', decision.id, { answers: ['Sim', ' Perfil '] }, 'web');
    expect(await db.getRepository(Task).findOneByOrFail({ id: task.id })).toMatchObject({
      status: 'PENDING',
      stage: 'QUEUED',
      attempts: 0,
      result: null,
    });
    expect(await db.getRepository(Outbox).countBy({ taskId: task.id })).toBe(1);
    const notes = clarificationsFrom(await db.getRepository(Decision).find());
    expect(notes.map((c) => [c.kind, c.question, c.text])).toEqual([
      ['answer', 'Motivo obrigatório?', 'Sim'],
      ['answer', 'Qual tela?', 'Perfil'],
    ]);
    expect(await db.getRepository(Decision).findOneByOrFail({ id: decision.id })).toMatchObject({
      status: 'answered',
      answeredVia: 'web',
      answer: { answers: ['Sim', 'Perfil'] },
    });
  });
  test('missing or blank answers are refused and nothing resumes', async () => {
    const { orchestrator, task, decision } = await waiting('question');
    for (const answer of [
      { answers: ['Sim'] },
      { answers: ['Sim', '   '] },
      { action: 'retry' as const },
    ])
      await expect(
        orchestrator.answerDecision('acme', decision.id, answer, 'web'),
      ).rejects.toMatchObject({ reason: 'invalid' });
    expect((await db.getRepository(Task).findOneByOrFail({ id: task.id })).status).toBe('WAITING');
    expect(await db.getRepository(Outbox).countBy({ taskId: task.id })).toBe(0);
  });
  test('a decision is answered once; the second answer is a conflict', async () => {
    const { orchestrator, decision } = await waiting('failure');
    await orchestrator.answerDecision('acme', decision.id, { action: 'retry' }, 'telegram');
    await expect(
      orchestrator.answerDecision('acme', decision.id, { action: 'cancel' }, 'web'),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
  test('retry with instructions queues the job and records the instruction', async () => {
    const { orchestrator, task, decision } = await waiting('failure');
    await orchestrator.answerDecision(
      'acme',
      decision.id,
      { action: 'retry_with_instructions', instructions: 'Use o enum RefusalReason' },
      'web',
    );
    expect((await db.getRepository(Task).findOneByOrFail({ id: task.id })).status).toBe('PENDING');
    expect(clarificationsFrom(await db.getRepository(Decision).find())).toMatchObject([
      { kind: 'instruction', text: 'Use o enum RefusalReason' },
    ]);
  });
  test('cancel closes a failed job', async () => {
    const { orchestrator, task, decision } = await waiting('failure');
    await orchestrator.answerDecision('acme', decision.id, { action: 'cancel' }, 'web');
    expect((await db.getRepository(Task).findOneByOrFail({ id: task.id })).status).toBe(
      'CANCELLED',
    );
    expect(await db.getRepository(Outbox).countBy({ taskId: task.id })).toBe(0);
  });
  test("another tenant's decision does not exist", async () => {
    const { orchestrator, decision } = await waiting('failure');
    await expect(
      orchestrator.answerDecision('globex', decision.id, { action: 'retry' }, 'web'),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
  test('retry_task and cancel_task close the open decision of the job', async () => {
    const a = await waiting('failure');
    await a.orchestrator.retry('acme', a.task.id);
    expect(await db.getRepository(Decision).findOneByOrFail({ id: a.decision.id })).toMatchObject({
      status: 'answered',
      answer: { action: 'retry' },
      answeredVia: 'api',
    });
    // The decision is closed: answering it now is a conflict, so nothing runs twice.
    await expect(
      a.orchestrator.answerDecision('acme', a.decision.id, { action: 'retry' }, 'web'),
    ).rejects.toMatchObject({ reason: 'conflict' });
    const b = await waiting('question', '124');
    await b.orchestrator.cancel('acme', b.task.id);
    expect((await db.getRepository(Task).findOneByOrFail({ id: b.task.id })).status).toBe(
      'CANCELLED',
    );
    expect((await db.getRepository(Decision).findOneByOrFail({ id: b.decision.id })).status).toBe(
      'answered',
    );
  });
});
describe('restarting a card', () => {
  const finish = (id: string, result: Record<string, unknown> = {}) =>
    db.getRepository(Task).update(id, { status: 'SUCCESS', stage: 'REHEARSED', result } as never);
  test('without again the card keeps its task; with again a finished one gets a new task', async () => {
    const service = new OrchestratorService(db, new TenantRegistry());
    const first = await service.accept('acme', item);
    await finish(first.id, { rehearsal: { files: ['a.ts'] } });
    expect((await service.accept('acme', item)).id).toBe(first.id);
    const second = await service.accept('acme', item, { again: true });
    expect(second.id).not.toBe(first.id);
    expect(second.issueId).toBe(first.issueId);
    expect(second.status).toBe('PENDING');
    // the earlier task is kept, pointing at the new one; the card's task is now the newest
    const earlier = await db.getRepository(Task).findOneByOrFail({ id: first.id });
    expect(earlier.result).toMatchObject({
      supersededBy: second.id,
      rehearsal: { files: ['a.ts'] },
    });
    expect((await service.accept('acme', item)).id).toBe(second.id);
    expect(await db.getRepository(Issue).count()).toBe(1);
    expect(await db.getRepository(Outbox).count()).toBe(2);
  });
  test('a card whose task is still going, or that published a PR, is never restarted', async () => {
    const service = new OrchestratorService(db, new TenantRegistry());
    const task = await service.accept('acme', item);
    await expect(service.accept('acme', item, { again: true })).rejects.toThrow(/em andamento/);
    await finish(task.id, { prUrl: 'https://git.example.com/pr/1' });
    await expect(service.accept('acme', item, { again: true })).rejects.toThrow(/PR\/MR/);
    await finish(task.id, { rehearsal: { promoted: true } });
    await expect(service.accept('acme', item, { again: true })).rejects.toThrow(/PR\/MR/);
    expect(await db.getRepository(Task).count()).toBe(1);
  });
  test('a failed or cancelled task can be restarted too', async () => {
    const service = new OrchestratorService(db, new TenantRegistry());
    const task = await service.accept('acme', item);
    await db.getRepository(Task).update(task.id, { status: 'FAILED' } as never);
    const again = await service.accept('acme', item, { again: true });
    expect(again.id).not.toBe(task.id);
  });
});

test('restarting settles the open decisions of the old task, which then refuses answers', async () => {
  const service = new OrchestratorService(db, new TenantRegistry());
  const first = await service.accept('acme', item);
  await db.getRepository(Task).update(first.id, { status: 'FAILED' } as never);
  const failure = await db.getRepository(Decision).save({
    tenantId: 'acme',
    taskId: first.id,
    revisionId: null,
    type: 'failure',
    status: 'open',
    reason: 'TESTS: Tests failed',
  });
  const second = await service.accept('acme', item, { again: true });
  const settled = await db.getRepository(Decision).findOneByOrFail({ id: failure.id });
  expect(settled).toMatchObject({
    status: 'answered',
    answer: { superseded: second.id },
    answeredVia: 'restart',
  });
  // a decision of the old task opened later (or answered elsewhere) cannot revive it
  const late = (await db
    .getRepository(Decision)
    .save({ ...failure, id: undefined, status: 'open' } as never)) as unknown as Decision;
  await expect(service.answerDecision('acme', late.id, { action: 'retry' }, 'web')).rejects.toThrow(
    `Este card foi refeito na tarefa ${second.id}`,
  );
  // a cancel is still allowed
  await service.answerDecision('acme', late.id, { action: 'cancel' }, 'web');
  expect((await db.getRepository(Task).findOneByOrFail({ id: first.id })).status).toBe('CANCELLED');
});
