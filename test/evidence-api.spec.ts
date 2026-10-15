import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { database, item } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Task } from '../src/database/entities';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { evidenceDir } from '../src/evidence/evidence-store';
let db: DataSource, app: INestApplication, url: string, registry: TenantRegistry;
const auth = { Authorization: `Bearer ${process.env.API_TOKEN}` };
const SHOT = { file: '01-tela.png', title: 'Tela', url: 'http://localhost:3000/x', at: 'T' };
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
});
afterEach(async () => {
  await app.close();
  await db.destroy();
});
async function withEvidence() {
  const task = await new OrchestratorService(db, registry).accept('acme', item);
  await db.getRepository(Task).update(task.id, {
    status: 'SUCCESS',
    result: { evidence: { shots: [SHOT], comment: 'Teste desenvolvedor:\n…', trace: 'trace.zip' } },
  });
  const dir = evidenceDir('acme', task.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '01-tela.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, 'trace.zip'), 'zip');
  return { task, dir };
}
test('the task view carries the prints and the ready comment', async () => {
  const { task, dir } = await withEvidence();
  const view = await (
    await fetch(`${url}/tenants/acme/tasks/${task.id}`, { headers: auth })
  ).json();
  expect(view.evidence).toEqual({ shots: [SHOT], comment: 'Teste desenvolvedor:\n…', trace: true });
  await rm(dir, { recursive: true, force: true });
});
test('prints and trace are served with their types; nothing else is', async () => {
  const { task, dir } = await withEvidence();
  const get = (file: string) =>
    fetch(`${url}/tenants/acme/tasks/${task.id}/evidence/${file}`, { headers: auth });
  const png = await get('01-tela.png');
  expect(png.status).toBe(200);
  expect(png.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const zip = await get('trace.zip');
  expect(zip.headers.get('content-type')).toBe('application/zip');
  expect((await get('..%2F..%2Fsecret.png')).status).toBe(400);
  expect((await get('notes.txt')).status).toBe(400);
  expect((await get('02-missing.png')).status).toBe(404);
  expect((await fetch(`${url}/tenants/acme/tasks/${task.id}/evidence/01-tela.png`)).status).toBe(
    401,
  );
  await rm(dir, { recursive: true, force: true });
});
test("another company's task answers like a missing one", async () => {
  const { task, dir } = await withEvidence();
  const r = await fetch(`${url}/tenants/globex/tasks/${task.id}/evidence/01-tela.png`, {
    headers: auth,
  });
  expect(r.status).toBe(404);
  await rm(dir, { recursive: true, force: true });
});
