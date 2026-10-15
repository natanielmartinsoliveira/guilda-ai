import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { database } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Issue } from '../src/database/entities';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { loadTenants, useTenants } from '../src/tenants/tenants';
import { CODER_PROJECT, coderTenantYaml } from './fixtures/coder-tenant';
import { METHOD_PACK } from './fixtures/method-ws';
let db: DataSource, app: INestApplication, url: string;
const auth = { Authorization: `Bearer ${process.env.API_TOKEN}` };
beforeEach(async () => {
  useTenants(
    loadTenants(
      coderTenantYaml(
        `${CODER_PROJECT}\n        method: { name: review-gate }`,
        `    packDir: ${METHOD_PACK}`,
      ),
    ),
  );
  db = await database();
  @Module({
    controllers: [TasksController],
    providers: [
      { provide: DataSource, useValue: db },
      TenantRegistry,
      OrchestratorService,
      WebAuthService,
      { provide: JiraPoller, useValue: {} },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  url = (await app.getUrl()) + '/api';
});
afterEach(async () => {
  await app.close();
  await db.destroy();
  useTenants(undefined);
});
const create = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${url}/tenants/initech/tasks`, { method: 'POST', headers: auth, body: form });
};
test('a project with a method asks which route the change takes', async () => {
  const r = await create({ title: 'Bloquear desconto', description: 'x' });
  expect(r.status).toBe(400);
  expect((await r.json()).message).toMatch(/rota/);
});
test('the chosen route is kept with the card', async () => {
  const r = await create({ title: 'Bloquear desconto', description: 'x', route: 'feature' });
  expect(r.status).toBe(202);
  const issue = await db.getRepository(Issue).findOneByOrFail({ title: 'Bloquear desconto' });
  expect(issue.meta?.route).toBe('feature');
});
test('an unknown route is refused', async () => {
  expect((await create({ title: 't', route: 'whatever' })).status).toBe(400);
});
test("the tenant listing tells the front each project's method and its routes", async () => {
  const list = await (await fetch(`${url}/tenants`, { headers: auth })).json();
  expect(list[0].projects[0]).toMatchObject({ id: 'svc', method: 'review-gate' });
  expect(list[0].projects[0].routes.map((r: { id: string }) => r.id)).toEqual([
    'feature',
    'screen',
    'fix',
    'adopt',
    'cleanup',
    'direct',
  ]);
  expect(list[0].projects[0].routes[0].label).toBe('Funcionalidade nova (especificação → entrega)');
});
test('a name of an object internal is not a route', async () => {
  expect((await create({ title: 't', route: 'constructor' })).status).toBe(400);
});
