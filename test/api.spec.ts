import * as tenantConfig from '../src/tenants/tenants';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { readFile, rm } from 'node:fs/promises';
import { database } from './db';
import { TasksController } from '../src/api/tasks.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Issue, Outbox, Task, Decision, AgentRun } from '../src/database/entities';
import { attachmentsDir } from '../src/attachments/attachments';
import * as settings from '../src/config';
import { WebAuthService } from '../src/web/web-auth.service';
import { JiraPoller } from '../src/sources/jira/jira.poller';
const poller = { startFromKey: jest.fn(), subtaskBases: jest.fn() };
let db: DataSource, app: INestApplication, url: string;
const auth = { Authorization: `Bearer ${process.env.API_TOKEN}` };
beforeEach(async () => {
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
  url = (await app.getUrl()) + '/api';
});
afterEach(async () => {
  await app.close();
  await db.destroy();
  await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
  jest.restoreAllMocks();
});
function form(fields: Record<string, string>, files: [string, string, string?][] = []) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  for (const [name, content, type] of files)
    body.append('files', new Blob([content], { type: type ?? 'text/plain' }), name);
  return body;
}
test('requires the operator token', async () => {
  expect((await fetch(`${url}/tenants`)).status).toBe(401);
  expect(
    (await fetch(`${url}/tenants`, { headers: { Authorization: 'Bearer wrong' } })).status,
  ).toBe(401);
});
test('API does not exist without API_TOKEN', async () => {
  jest.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), API_TOKEN: undefined });
  expect((await fetch(`${url}/tenants`, { headers: auth })).status).toBe(404);
});
test('lists tenants and projects without secrets', async () => {
  const r = await fetch(`${url}/tenants`, { headers: auth });
  const text = await r.text();
  expect(JSON.parse(text).map((t: { id: string }) => t.id)).toEqual(['acme', 'globex']);
  expect(JSON.parse(text).map((t: { concurrency: number }) => t.concurrency)).toEqual([1, 1]);
  expect(JSON.parse(text).map((t: { officeTheme: string }) => t.officeTheme)).toEqual([
    'guild',
    'guild',
  ]);
  expect(text).not.toContain('test-acme');
  expect(text).not.toContain('test-globex');
});
test('lists configured concurrency without changing the worker', async () => {
  const list = tenantConfig.tenants();
  const spy = jest
    .spyOn(tenantConfig, 'tenants')
    .mockReturnValue(list.map((t, i) => ({ ...t, worker: { concurrency: i ? 3 : 1 } })));
  try {
    const response = await fetch(`${url}/tenants`, { headers: auth });
    expect((await response.json()).map((t: { concurrency: number }) => t.concurrency)).toEqual([
      1, 3,
    ]);
  } finally {
    spy.mockRestore();
  }
  expect(tenantConfig.tenants()).toEqual(list);
});
test('creates a task with sanitized attachments stored before the task is queued', async () => {
  const r = await fetch(`${url}/tenants/acme/tasks`, {
    method: 'POST',
    headers: auth,
    body: form({ title: 'Fix login', description: 'See screenshot' }, [
      ['../../etc/evil name.sh', 'echo hi'],
      ['screen.png', 'png-bytes', 'image/png'],
    ]),
  });
  expect(r.status).toBe(202);
  const created = await r.json();
  expect(created.key).toMatch(/^T-[0-9a-f]{8}$/);
  expect(created.attachments.map((a: { name: string }) => a.name)).toEqual([
    'evil_name.sh',
    'screen.png',
  ]);
  const issue = await db.getRepository(Issue).findOneByOrFail({ source: 'api' });
  expect(issue).toMatchObject({ tenantId: 'acme', title: 'Fix login', body: 'See screenshot' });
  expect(issue.attachments?.[1]).toEqual({ name: 'screen.png', contentType: 'image/png', size: 9 });
  const dir = attachmentsDir('acme', 'api', issue.externalId);
  expect(dir.startsWith(process.env.ATTACHMENTS_ROOT!)).toBe(true);
  expect(await readFile(`${dir}/evil_name.sh`, 'utf8')).toBe('echo hi');
  expect(await db.getRepository(Outbox).count()).toBe(1);
  const task = await db.getRepository(Task).findOneByOrFail({ id: created.taskId });
  expect(task.provider).toBe('codex');
});
test('rejects files above the size limit before creating anything', async () => {
  const r = await fetch(`${url}/tenants/acme/tasks`, {
    method: 'POST',
    headers: auth,
    body: form({ title: 'Big' }, [['big.log', 'x'.repeat(3000)]]),
  });
  expect(r.status).toBe(413);
  expect(await db.getRepository(Task).count()).toBe(0);
});
test('validates title and project', async () => {
  const noTitle = await fetch(`${url}/tenants/acme/tasks`, {
    method: 'POST',
    headers: auth,
    body: form({ description: 'x' }),
  });
  expect(noTitle.status).toBe(400);
  const wrongProject = await fetch(`${url}/tenants/acme/tasks`, {
    method: 'POST',
    headers: auth,
    body: form({ title: 't', project: 'site' }),
  });
  expect(wrongProject.status).toBe(400);
  expect(await wrongProject.text()).toContain('project must be one of: demo');
});
test('task ids never cross tenants', async () => {
  const created = await (
    await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'Only acme' }),
    })
  ).json();
  const own = await fetch(`${url}/tenants/acme/tasks/${created.taskId}`, { headers: auth });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ status: 'PENDING', title: 'Only acme', source: 'api' });
  const other = await fetch(`${url}/tenants/globex/tasks/${created.taskId}`, { headers: auth });
  expect(other.status).toBe(404);
  const list = await (await fetch(`${url}/tenants/globex/tasks`, { headers: auth })).json();
  expect(list).toEqual([]);
  expect(await (await fetch(`${url}/tenants/nobody/tasks`, { headers: auth })).status).toBe(404);
});
test('shows AI credentials in fallback order with their state, never the keys', async () => {
  const { CredentialState } = await import('../src/database/entities');
  await db.getRepository(CredentialState).save({
    tenantId: 'acme',
    credentialId: 'openai-main',
    unavailableUntil: new Date(Date.now() + 3600000),
    reason: 'quota',
    lastError: 'You exceeded your current quota',
  });
  const r = await fetch(`${url}/tenants/acme/ai`, { headers: auth });
  const text = await r.text();
  expect(text).not.toContain('test-acme-openai-key');
  expect(JSON.parse(text)).toEqual([
    expect.objectContaining({
      id: 'openai-main',
      auth: 'apiKey',
      available: false,
      reason: 'quota',
    }),
    expect.objectContaining({
      id: 'claude-max',
      auth: 'login',
      available: true,
      model: 'claude-sonnet-5',
    }),
  ]);
});
test('requests a revision with files once the task has its PR', async () => {
  const created = await (
    await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'Feature' }),
    })
  ).json();
  const revise = () =>
    fetch(`${url}/tenants/acme/tasks/${created.taskId}/revisions`, {
      method: 'POST',
      headers: auth,
      body: form({ instructions: 'Use the new colors' }, [['palette.png', 'png', 'image/png']]),
    });
  const early = await revise();
  expect(early.status).toBe(409);
  expect(await early.text()).toContain('no pull request yet');
  const { PullRequest } = await import('../src/database/entities');
  await db.getRepository(Task).update(created.taskId, { status: 'SUCCESS' });
  await db.getRepository(PullRequest).save({
    taskId: created.taskId,
    host: 'gh',
    externalId: '1',
    number: 3,
    title: 't',
    url: 'https://github.com/example/demo/pull/3',
    branch: 'b',
    baseBranch: 'main',
    state: 'open',
  });
  const r = await revise();
  expect(r.status).toBe(202);
  const { revisionId, number } = await r.json();
  expect(number).toBe(1);
  const issue = await db.getRepository(Issue).findOneByOrFail({ source: 'api' });
  expect(
    await readFile(
      `${attachmentsDir('acme', 'api', issue.externalId)}/rev-${revisionId}/palette.png`,
      'utf8',
    ),
  ).toBe('png');
  const status = await (
    await fetch(`${url}/tenants/acme/tasks/${created.taskId}`, { headers: auth })
  ).json();
  expect(status.revisions).toEqual([
    expect.objectContaining({ number: 1, status: 'PENDING', instructions: 'Use the new colors' }),
  ]);
  const missing = await fetch(`${url}/tenants/globex/tasks/${created.taskId}/revisions`, {
    method: 'POST',
    headers: auth,
    body: form({ instructions: 'x' }),
  });
  expect(missing.status).toBe(404);
});
test('retry and cancel endpoints with clear conflicts', async () => {
  const created = await (
    await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'X' }),
    })
  ).json();
  const post = (action: string, query = '') =>
    fetch(`${url}/tenants/acme/tasks/${created.taskId}/${action}${query}`, {
      method: 'POST',
      headers: auth,
    });
  const early = await post('retry');
  expect(early.status).toBe(409);
  expect(await early.text()).toContain('status: PENDING');
  const cancel = await post('cancel');
  expect(cancel.status).toBe(200);
  expect(await cancel.json()).toMatchObject({ status: 'CANCELLED' });
  const retry = await post('retry');
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({ status: 'PENDING', stage: 'QUEUED' });
  expect((await post('retry', '?revision=0')).status).toBe(400);
  expect((await post('retry', '?revision=3')).status).toBe(404);
});
describe('decisions', () => {
  async function failedTask() {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'Fix login', description: 'x' }),
    });
    const { taskId } = await r.json();
    await db.getRepository(Task).update(taskId, { status: 'FAILED', stage: 'TESTS' });
    const decision = await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId,
      revisionId: null,
      type: 'failure',
      status: 'open',
      reason: 'TESTS: Tests failed',
      details: 'boom',
    });
    return { taskId, decision };
  }
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  test('lists open decisions with their card, newest first; requires the token', async () => {
    const { decision } = await failedTask();
    expect((await fetch(`${url}/tenants/acme/decisions`)).status).toBe(401);
    const list = await (await fetch(`${url}/tenants/acme/decisions`, { headers: auth })).json();
    expect(list).toMatchObject([
      {
        id: decision.id,
        type: 'failure',
        status: 'open',
        reason: 'TESTS: Tests failed',
        title: 'Fix login',
      },
    ]);
    expect(
      await (await fetch(`${url}/tenants/globex/decisions`, { headers: auth })).json(),
    ).toEqual([]);
  });
  test('answers a decision once; invalid bodies are 400, a second answer is 409', async () => {
    const { taskId, decision } = await failedTask();
    expect(
      (await post(`/tenants/acme/decisions/${decision.id}/answer`, { action: 'jump' })).status,
    ).toBe(400);
    const ok = await post(`/tenants/acme/decisions/${decision.id}/answer`, { action: 'retry' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'answered', answer: { action: 'retry' } });
    expect((await db.getRepository(Task).findOneByOrFail({ id: taskId })).status).toBe('PENDING');
    expect(
      (await post(`/tenants/acme/decisions/${decision.id}/answer`, { action: 'retry' })).status,
    ).toBe(409);
    expect(
      (await post(`/tenants/globex/decisions/${decision.id}/answer`, { action: 'retry' })).status,
    ).toBe(404);
  });
});
describe('front session on /api', () => {
  async function session() {
    const auth = app.get(WebAuthService);
    jest
      .spyOn(auth, 'session')
      .mockImplementation(async (token) =>
        token === 'good-token' ? ({ id: 's1' } as never) : undefined,
      );
    jest.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      WEB_PUBLIC_URL: 'https://front.example.dev',
    });
  }
  const cookie = (token: string) => ({ Cookie: `adt_session=${token}` });
  test('a valid session reads /api; a missing, expired or revoked one is 401', async () => {
    await session();
    expect((await fetch(`${url}/tenants`, { headers: cookie('good-token') })).status).toBe(200);
    expect((await fetch(`${url}/tenants`, { headers: cookie('stale-token') })).status).toBe(401);
  });
  test('actions with a session need the front origin; the MCP token does not', async () => {
    await session();
    const create = (headers: Record<string, string>) =>
      fetch(`${url}/tenants/acme/tasks`, {
        method: 'POST',
        headers,
        body: form({ title: 'x', description: 'y' }),
      });
    expect((await create(cookie('good-token'))).status).toBe(403);
    expect((await create({ ...cookie('good-token'), Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect(
      (await create({ ...cookie('good-token'), Origin: 'https://front.example.dev' })).status,
    ).toBe(202);
    expect((await create(auth)).status).toBe(202);
  });
  test('answers through the front are recorded as web', async () => {
    await session();
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    await db.getRepository(Task).update(taskId, { status: 'FAILED' });
    const decision = await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId,
      revisionId: null,
      type: 'failure',
      status: 'open',
      reason: 'x',
    });
    const answered = await fetch(`${url}/tenants/acme/decisions/${decision.id}/answer`, {
      method: 'POST',
      headers: {
        ...cookie('good-token'),
        Origin: 'https://front.example.dev',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(answered.status).toBe(200);
    expect(
      (await db.getRepository(Decision).findOneByOrFail({ id: decision.id })).answeredVia,
    ).toBe('web');
  });
});
describe('front data', () => {
  beforeEach(() => poller.startFromKey.mockReset());
  test('tenants say whether they have Jira', async () => {
    const list = await (await fetch(`${url}/tenants`, { headers: auth })).json();
    expect(list.map((t: { id: string; jira: boolean }) => [t.id, t.jira])).toEqual([
      ['acme', true],
      ['globex', false],
    ]);
  });
  test('task detail carries review, checks and decisions', async () => {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    await db.getRepository(Task).update(taskId, {
      result: {
        review: { final: 'approved', rounds: [] },
        checks: { findings: [], tools: {}, errors: [] },
      },
    });
    await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId,
      revisionId: null,
      type: 'question',
      status: 'answered',
      questions: [{ text: 'Q?' }],
    });
    const detail = await (
      await fetch(`${url}/tenants/acme/tasks/${taskId}`, { headers: auth })
    ).json();
    expect(detail.review).toEqual({ final: 'approved', rounds: [] });
    expect(detail.checks).toMatchObject({ findings: [] });
    expect(detail.decisions).toMatchObject([{ type: 'question', status: 'answered' }]);
  });
  test('task views say tenant, project and branch; the detail lists runs without commands (3b)', async () => {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    await db.getRepository(AgentRun).save({
      taskId,
      agent: 'coder',
      provider: 'claude',
      status: 'SUCCESS',
      command: 'claude -p segredo-do-prompt',
      stdout: 'saida',
      stderr: '',
      exitCode: 0,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const [listed] = await (await fetch(`${url}/tenants/acme/tasks`, { headers: auth })).json();
    expect(listed).toMatchObject({ tenantId: 'acme', project: 'demo' });
    expect(typeof listed.branch).toBe('string');
    expect(listed.runs).toBeUndefined();
    const detail = await (
      await fetch(`${url}/tenants/acme/tasks/${taskId}`, { headers: auth })
    ).json();
    expect(detail.runs).toEqual([
      expect.objectContaining({
        agent: 'coder',
        provider: 'claude',
        status: 'SUCCESS',
        exitCode: 0,
      }),
    ]);
    expect(JSON.stringify(detail.runs)).not.toContain('segredo');
    expect(JSON.stringify(detail.runs)).not.toContain('saida');
  });
  test('decision views carry their tenant (3b)', async () => {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId,
      revisionId: null,
      type: 'question',
      status: 'open',
      questions: [{ text: 'Q?' }],
    });
    const [decision] = await (
      await fetch(`${url}/tenants/acme/decisions`, { headers: auth })
    ).json();
    expect(decision.tenantId).toBe('acme');
  });
  test('a sub-task starts from the chosen base; its bases are listed', async () => {
    poller.startFromKey.mockResolvedValueOnce({ taskId: 't-2' });
    const r = await fetch(`${url}/tenants/acme/tasks/from-jira`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DEMO-103', base: 'feature/DEMO-101' }),
    });
    expect(r.status).toBe(202);
    expect(poller.startFromKey).toHaveBeenLastCalledWith('acme', 'DEMO-103', 'feature/DEMO-101');
    const bad = await fetch(`${url}/tenants/acme/tasks/from-jira`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DEMO-103', base: 'x; rm -rf' }),
    });
    expect(bad.status).toBe(400);
    poller.subtaskBases.mockResolvedValueOnce({ subtask: false });
    const listed = await fetch(`${url}/tenants/acme/jira/DEMO-103/bases`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ subtask: false });
    expect(poller.subtaskBases).toHaveBeenCalledWith('acme', 'DEMO-103');
    expect((await fetch(`${url}/tenants/acme/jira/bad-key/bases`, { headers: auth })).status).toBe(
      400,
    );
  });
  test('starts a task from a Jira card key', async () => {
    poller.startFromKey.mockResolvedValueOnce({ taskId: 't-1' });
    const post = (body: unknown) =>
      fetch(`${url}/tenants/acme/tasks/from-jira`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ok = await post({ key: 'DEMO-100' });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ taskId: 't-1' });
    expect(poller.startFromKey).toHaveBeenCalledWith('acme', 'DEMO-100');
    expect((await post({ key: 'not a key' })).status).toBe(400);
    poller.startFromKey.mockResolvedValueOnce({
      skipped: 'Esse card já tem tarefa',
      taskId: 't-1',
    });
    const skipped = await post({ key: 'DEMO-100' });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ skipped: 'Esse card já tem tarefa', taskId: 't-1' });
    poller.startFromKey.mockRejectedValueOnce(new Error('Empresa sem fonte Jira'));
    expect((await post({ key: 'DEMO-1' })).status).toBe(404);
    poller.startFromKey.mockRejectedValueOnce(new Error('Jira GET /issue returned 404'));
    const missing = await post({ key: 'DEMO-9' });
    expect(missing.status).toBe(502);
    expect((await missing.json()).message).toContain('404');
  });
});
describe('live updates', () => {
  async function next(reader: ReadableStreamDefaultReader<Uint8Array>, match: string, ms = 3000) {
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 500),
        ),
      ]);
      if (value) text += decoder.decode(value);
      if (text.includes(match)) return text;
    }
    throw new Error(`no event with ${match}; got: ${text}`);
  }
  test('one change is pushed once, not on every tick (finding 5)', async () => {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    const controller = new AbortController();
    const stream = await fetch(`${url}/events`, { headers: auth, signal: controller.signal });
    const reader = stream.body!.getReader();
    await new Promise((done) => setTimeout(done, 150));
    await db.getRepository(Task).update(taskId, { stage: 'TESTS', status: 'RUNNING' });
    let text = await next(reader, taskId);
    const end = Date.now() + 800;
    const decoder = new TextDecoder();
    while (Date.now() < end) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((done) =>
          setTimeout(() => done({ value: undefined }), 200),
        ),
      ]);
      if (value) text += decoder.decode(value);
    }
    controller.abort();
    expect(text.split(`"id":"${taskId}"`).length - 1).toBe(1);
  });
  test('a task change is pushed to the open stream; closing it stops the polling', async () => {
    const r = await fetch(`${url}/tenants/acme/tasks`, {
      method: 'POST',
      headers: auth,
      body: form({ title: 'x', description: 'y' }),
    });
    const { taskId } = await r.json();
    const controller = new AbortController();
    const stream = await fetch(`${url}/events`, { headers: auth, signal: controller.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    await new Promise((done) => setTimeout(done, 150));
    await db.getRepository(Task).update(taskId, { stage: 'TESTS', status: 'RUNNING' });
    const text = await next(reader, taskId);
    expect(text).toContain('event: change');
    expect(text).toContain('"stage":"TESTS"');
    const spy = jest.spyOn(db, 'getRepository');
    controller.abort();
    await new Promise((done) => setTimeout(done, 400));
    spy.mockClear();
    await new Promise((done) => setTimeout(done, 300));
    expect(spy).not.toHaveBeenCalled();
  });
});

test('lists each company office theme without configuration secrets', async () => {
  const list = tenantConfig.tenants();
  const spy = jest
    .spyOn(tenantConfig, 'tenants')
    .mockReturnValue(list.map((t, i) => ({ ...t, office: { theme: i ? 'pipeline' : 'studio' } })));
  try {
    const response = await fetch(`${url}/tenants`, { headers: auth });
    expect((await response.json()).map((t: { officeTheme: string }) => t.officeTheme)).toEqual([
      'studio',
      'pipeline',
    ]);
  } finally {
    spy.mockRestore();
  }
});
