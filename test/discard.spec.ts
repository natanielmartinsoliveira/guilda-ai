import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { database, item } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Task } from '../src/database/entities';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { CoderWorkspace } from '../src/workspaces/coder-workspace';
const CODER = {
  type: 'coder' as const,
  url: 'https://coder.example.com',
  name: 'ws',
  root: '/root/ai',
  protect: ['/workspaces'],
};
let db: DataSource, app: INestApplication, url: string, registry: TenantRegistry;
const auth = { Authorization: `Bearer ${process.env.API_TOKEN}` };
let destroy: jest.SpyInstance;
beforeEach(async () => {
  db = await database();
  registry = new TenantRegistry();
  @Module({
    controllers: [TasksController],
    providers: [
      { provide: DataSource, useValue: db },
      { provide: TenantRegistry, useValue: registry },
      OrchestratorService,
      WebAuthService,
      { provide: JiraPoller, useValue: {} },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  url = (await app.getUrl()) + '/api';
  destroy = jest.spyOn(CoderWorkspace.prototype, 'destroy').mockResolvedValue();
});
afterEach(async () => {
  await app.close();
  await db.destroy();
  jest.restoreAllMocks();
});
async function coderTask(status: Task['status'], result: Record<string, unknown>) {
  const task = await new OrchestratorService(db, registry).accept('acme', item);
  await db.getRepository(Task).update(task.id, { status, result: result as any });
  const project = registry.project.bind(registry);
  jest.spyOn(registry, 'project').mockImplementation((t, id) => {
    const ctx = project(t, id);
    return { ...ctx, project: { ...ctx.project, workspace: CODER, delivery: 'rehearsal' } } as any;
  });
  return task;
}
const discard = (id: string) =>
  fetch(`${url}/tenants/acme/tasks/${id}/discard`, { method: 'POST', headers: auth });
test('discard removes the coder folder of a finished rehearsal and says so', async () => {
  const task = await coderTask('SUCCESS', { rehearsal: { workspace: 'ws:/root/ai/t' } });
  const r = await discard(task.id);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ discarded: true });
  expect(destroy).toHaveBeenCalledTimes(1);
  const saved = await db.getRepository(Task).findOneByOrFail({ id: task.id });
  expect(saved.result!.rehearsal).toMatchObject({ discarded: true });
});
test('a failed coder task can be discarded too', async () => {
  const task = await coderTask('FAILED', {});
  expect((await discard(task.id)).status).toBe(200);
  expect((await db.getRepository(Task).findOneByOrFail({ id: task.id })).result!.discarded).toBe(
    true,
  );
});
test.each(['PENDING', 'RUNNING', 'WAITING'] as const)(
  'a %s task is never discarded (focus 5)',
  async (status) => {
    const task = await coderTask(status, {});
    expect((await discard(task.id)).status).toBe(409);
    expect(destroy).not.toHaveBeenCalled();
  },
);
test('local projects have nothing to discard', async () => {
  const task = await new OrchestratorService(db, registry).accept('acme', item);
  await db.getRepository(Task).update(task.id, { status: 'SUCCESS' });
  expect((await discard(task.id)).status).toBe(400);
  expect(destroy).not.toHaveBeenCalled();
});
test('unknown task: 404', async () => {
  expect((await discard('33333333-3333-4333-8333-333333333333')).status).toBe(404);
});
test('a task the worker still holds (cancelled while running) is not discarded', async () => {
  const { EntityManager } = await import('typeorm');
  const task = await coderTask('CANCELLED', {});
  const query = EntityManager.prototype.query;
  jest.spyOn(EntityManager.prototype, 'query').mockImplementation(function (
    this: InstanceType<typeof EntityManager>,
    sql: string,
    params?: unknown[],
  ) {
    if (sql.includes('pg_try_advisory_xact_lock')) return Promise.resolve([{ locked: false }]);
    return query.call(this, sql, params);
  });
  expect((await discard(task.id)).status).toBe(409);
  expect(destroy).not.toHaveBeenCalled();
});

const promote = (id: string) =>
  fetch(`${url}/tenants/acme/tasks/${id}/promote`, { method: 'POST', headers: auth });
test('promote queues a finished rehearsal (202) and refuses anything else (409)', async () => {
  const task = await coderTask('SUCCESS', { rehearsal: { workspace: 'ws:/root/ai/t' } });
  expect((await promote(task.id)).status).toBe(202);
  const queued = await db.getRepository(Task).findOneByOrFail({ id: task.id });
  expect(queued.status).toBe('PENDING');
  expect(queued.result).toMatchObject({ promote: true, rehearsal: { workspace: 'ws:/root/ai/t' } });
  expect((await promote(task.id)).status).toBe(409);
  const failed = await coderTask('FAILED', {});
  expect((await promote(failed.id)).status).toBe(409);
});
