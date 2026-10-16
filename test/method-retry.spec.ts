import { DataSource } from 'typeorm';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Decision, Task } from '../src/database/entities';

/** A task of a method that failed for an outside reason (VPN, quota) resumes on a plain retry. */
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const METHOD_STATE = {
  baseSha: 'a'.repeat(40),
  method: { phase: 'deliver', authorization: 'Entregue o escopo 7' },
};
async function failedInDelivery(orchestrator: OrchestratorService, result: object | null) {
  const task = await orchestrator.accept('acme', item);
  await db
    .getRepository(Task)
    .update(task.id, { status: 'FAILED', stage: 'WORKSPACE', result: result as never });
  const decision = await db.getRepository(Decision).save({
    tenantId: 'acme',
    taskId: task.id,
    revisionId: null,
    type: 'failure',
    status: 'open',
    reason: 'WORKSPACE: Coder inacessível',
  });
  return { task, decision };
}
const reload = (id: string) => db.getRepository(Task).findOneByOrFail({ id });

test('Retry on a failed task of a method keeps its phase, authorization and base', async () => {
  const orchestrator = new OrchestratorService(db, new TenantRegistry());
  const { task, decision } = await failedInDelivery(orchestrator, METHOD_STATE);
  await orchestrator.answerDecision('acme', decision.id, { action: 'retry' }, 'telegram');
  const after = await reload(task.id);
  expect(after.status).toBe('PENDING');
  expect(after.result).toMatchObject(METHOD_STATE);
});
test('the API retry (retry_task) resumes a method too', async () => {
  const orchestrator = new OrchestratorService(db, new TenantRegistry());
  const { task } = await failedInDelivery(orchestrator, METHOD_STATE);
  await orchestrator.retry('acme', task.id);
  expect((await reload(task.id)).result).toMatchObject(METHOD_STATE);
});
test('Retry with instructions, or a task without a method, starts over', async () => {
  const orchestrator = new OrchestratorService(db, new TenantRegistry());
  const withInstructions = await failedInDelivery(orchestrator, METHOD_STATE);
  await orchestrator.answerDecision(
    'acme',
    withInstructions.decision.id,
    { action: 'retry_with_instructions', instructions: 'refaça a análise' },
    'web',
  );
  expect((await reload(withInstructions.task.id)).result).toBeNull();
  await db.destroy();
  db = await database();
  const plainOrchestrator = new OrchestratorService(db, new TenantRegistry());
  const plain = await failedInDelivery(plainOrchestrator, { baseSha: 'b'.repeat(40) });
  await plainOrchestrator.answerDecision('acme', plain.decision.id, { action: 'retry' }, 'web');
  expect((await reload(plain.task.id)).result).toBeNull();
});
