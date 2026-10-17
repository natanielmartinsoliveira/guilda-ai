import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { database } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Issue } from '../src/database/entities';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
const poller = { startFromKey: jest.fn() };
jest.setTimeout(60000);
let db: DataSource, app: INestApplication, client: Client, files: string;
beforeAll(async () => {
  db = await database();
  @Module({
    controllers: [TasksController],
    providers: [
      { provide: DataSource, useValue: db },
      TenantRegistry,
      OrchestratorService,
      WebAuthService,
      { provide: JiraPoller, useValue: poller },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  files = await mkdtemp(join(tmpdir(), 'mcp-files-'));
  // Real subprocess over stdio, exactly as an editor launches it.
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['-r', 'ts-node/register/transpile-only', resolve(__dirname, '../src/mcp/server.ts')],
      cwd: resolve(__dirname, '..'),
      env: {
        PATH: process.env.PATH!,
        AI_DEV_TEAM_URL: await app.getUrl(),
        API_TOKEN: process.env.API_TOKEN!,
        ATTACHMENT_MAX_BYTES: '2048',
      },
      stderr: 'pipe',
    }),
  );
});
afterAll(async () => {
  await client?.close();
  await app?.close();
  await db?.destroy();
  await rm(files, { recursive: true, force: true });
  await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
});
const result = (r: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((r.content as { text: string }[])[0].text);
test('exposes the tools', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    'ai_status',
    'answer_decision',
    'cancel_task',
    'create_task',
    'get_task',
    'list_decisions',
    'list_tasks',
    'list_tenants',
    'promote_task',
    'retry_task',
    'revise_task',
  ]);
});
test('creates a task with a local file and reads its status back', async () => {
  const shot = join(files, 'print tela.png');
  await writeFile(shot, 'png');
  const created = result(
    await client.callTool({
      name: 'create_task',
      arguments: { tenant: 'acme', title: 'Fix button', description: 'See print', files: [shot] },
    }),
  );
  expect(created.status).toBe('PENDING');
  expect(created.attachments).toEqual([
    { name: 'print_tela.png', contentType: 'image/png', size: 3 },
  ]);
  const issue = await db.getRepository(Issue).findOneByOrFail({ source: 'api' });
  expect(issue.title).toBe('Fix button');
  const status = result(
    await client.callTool({
      name: 'get_task',
      arguments: { tenant: 'acme', taskId: created.taskId },
    }),
  );
  expect(status).toMatchObject({
    id: created.taskId,
    status: 'PENDING',
    attachments: ['print_tela.png'],
  });
  const list = result(await client.callTool({ name: 'list_tasks', arguments: { tenant: 'acme' } }));
  expect(list).toHaveLength(1);
});
test('reports errors as tool errors instead of crashing', async () => {
  const missing = await client.callTool({
    name: 'create_task',
    arguments: { tenant: 'acme', title: 'x', files: ['/does/not/exist.txt'] },
  });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain('Not a readable file');
  const unknown = await client.callTool({
    name: 'list_tasks',
    arguments: { tenant: 'nobody' },
  });
  expect(unknown.isError).toBe(true);
  expect(JSON.stringify(unknown.content)).toContain('404');
});
