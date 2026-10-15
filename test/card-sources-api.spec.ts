import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { database } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { CardStarters } from '../src/sources/card-starters';
let db: DataSource, app: INestApplication, url: string;
const auth = {
  Authorization: `Bearer ${process.env.API_TOKEN}`,
  'Content-Type': 'application/json',
};
const calls: { source: string; key: string; base?: string; route?: string }[] = [];
let failWith: string | undefined;
const starter = {
  type: 'jira',
  label: 'Jira',
  key: 'jira',
  example: 'PF-123',
  routes: false,
  start: async (
    _t: unknown,
    source: { id: string },
    key: string,
    base?: string,
    route?: string,
  ) => {
    if (failWith) throw new Error(failWith);
    calls.push({ source: source.id, key, ...(base ? { base } : {}), ...(route ? { route } : {}) });
    return key === 'PF-9'
      ? { skipped: 'Esse card já tem tarefa', taskId: 't-old' }
      : { taskId: 't-new' };
  },
  bases: async () => ({ subtask: false }),
};
const starters = {
  for: (s: { type: string }) => (s.type === 'jira' ? starter : undefined),
  list: (t: { sources: { id: string; type: string }[] }) =>
    t.sources
      .filter((s) => s.type === 'jira')
      .map((s) => ({
        id: s.id,
        type: s.type,
        label: 'Jira',
        key: 'jira',
        example: 'PF-123',
        bases: true,
      })),
};
beforeEach(async () => {
  calls.length = 0;
  starter.routes = false;
  failWith = undefined;
  db = await database();
  @Module({
    controllers: [TasksController],
    providers: [
      { provide: DataSource, useValue: db },
      TenantRegistry,
      OrchestratorService,
      WebAuthService,
      { provide: JiraPoller, useValue: {} },
      { provide: CardStarters, useValue: starters },
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
const start = (tenant: string, source: string, body: unknown) =>
  fetch(`${url}/tenants/${tenant}/sources/${source}/start`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  });

test('the tenant listing tells which sources start cards', async () => {
  const list = await (await fetch(`${url}/tenants`, { headers: auth })).json();
  const acme = list.find((t: { id: string }) => t.id === 'acme');
  expect(acme.sources).toEqual([
    { id: 'jira', type: 'jira', label: 'Jira', key: 'jira', example: 'PF-123', bases: true },
  ]);
  expect(acme.jira).toBe(true);
});

test('start: 202 with the task, 200 when skipped; the key is normalized by the source format', async () => {
  const r = await start('acme', 'jira', { key: ' pf 12 ' });
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ taskId: 't-new' });
  expect(calls).toEqual([{ source: 'jira', key: 'PF-12' }]);
  const skipped = await start('acme', 'jira', { key: 'PF-9', base: 'story/pf-1' });
  expect(skipped.status).toBe(200);
  expect(calls[1]).toEqual({ source: 'jira', key: 'PF-9', base: 'story/pf-1' });
});

test('a key in the wrong format is a 400 with the source example', async () => {
  const r = await start('acme', 'jira', { key: 'nope' });
  expect(r.status).toBe(400);
  expect((await r.json()).message).toContain('PF-123');
});

test('a source that does not exist, or does not start cards, is a 404 (Review Focus 2)', async () => {
  expect((await start('acme', 'nope', { key: 'PF-1' })).status).toBe(404);
  expect((await start('acme', 'github', { key: 'PF-1' })).status).toBe(404);
  expect((await start('globex', 'jira', { key: 'PF-1' })).status).toBe(404);
});

test('a source failure is a 502 with the message redacted (Review Focus 5)', async () => {
  failWith = `connect ECONNREFUSED with token ${process.env.ACME_JIRA_TOKEN}`;
  const r = await start('acme', 'jira', { key: 'PF-1' });
  expect(r.status).toBe(502);
  expect(JSON.stringify(await r.json())).not.toContain(process.env.ACME_JIRA_TOKEN!);
});

test('bases: answered by sources that offer them, 404 otherwise', async () => {
  const ok = await fetch(`${url}/tenants/acme/sources/jira/cards/PF-1/bases`, { headers: auth });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ subtask: false });
  expect(
    (await fetch(`${url}/tenants/acme/sources/github/cards/PF-1/bases`, { headers: auth })).status,
  ).toBe(404);
});

test('a route goes to sources that take one; others refuse it; a bad name is a 400', async () => {
  expect((await start('acme', 'jira', { key: 'PF-12', route: 'fix' })).status).toBe(400);
  expect(calls).toEqual([]);
  starter.routes = true;
  expect((await start('acme', 'jira', { key: 'PF-12', route: 'Not A Route' })).status).toBe(400);
  const r = await start('acme', 'jira', { key: 'PF-12', route: 'fix' });
  expect(r.status).toBe(202);
  expect(calls).toEqual([{ source: 'jira', key: 'PF-12', route: 'fix' }]);
});
