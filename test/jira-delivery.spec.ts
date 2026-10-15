import { DataSource } from 'typeorm';
import { readFile, rm } from 'node:fs/promises';
import { JiraClient, JiraIssue } from '../src/sources/jira/jira.client';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { SourceReporter, SourceEvent } from '../src/sources/source-reporter.service';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { findTenant, JiraSource, tenants, useTenants } from '../src/tenants/tenants';
import { attachmentsDir } from '../src/attachments/attachments';
import { Issue, PullRequest, Revision, Task } from '../src/database/entities';
import { database } from './db';
const acme = () => findTenant('acme')!;
const cloud = () => acme().sources.find((s) => s.id === 'jira') as JiraSource;
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const parent: JiraIssue = {
  id: '60401',
  key: 'DEMO-100',
  fields: {
    summary: 'Recusa de indicações',
    description: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Regras RN01..RN08' }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'tela-admin.png' } }] },
      ],
    },
    project: { key: 'DEMO' },
    issuetype: { subtask: false },
    attachment: [
      {
        id: 'p1',
        filename: 'tela-admin.png',
        mimeType: 'image/png',
        size: 3,
        content: 'https://acme.atlassian.net/p1',
      },
    ],
    subtasks: [
      { id: '1', key: 'DEMO-101', fields: { status: { statusCategory: { key: 'new' } } } },
      { id: '2', key: 'DEMO-102', fields: { status: { statusCategory: { key: 'done' } } } },
      { id: '3', key: 'DEMO-103', fields: { status: { statusCategory: { key: 'new' } } } },
    ],
  },
};
const subtask = (id: string, key: string, summary: string, files: string[] = []): JiraIssue => ({
  id,
  key,
  fields: {
    summary,
    description: doc(`Detalhes de ${key}`),
    issuetype: { subtask: true },
    attachment: files.map((f) => ({
      id: f,
      filename: f,
      mimeType: 'image/png',
      size: 1,
      content: `https://acme.atlassian.net/${f}`,
    })),
  },
});
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
  await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
});
function setup(search: JiraIssue[]) {
  const client = {
    search: jest.fn().mockResolvedValue(search),
    issue: jest.fn(async (key: string) =>
      key === 'DEMO-101'
        ? subtask('1', 'DEMO-101', 'Migrations', ['erd.png'])
        : subtask('3', 'DEMO-103', 'Endpoint de recusa', ['api.png']),
    ),
    download: jest.fn(async () => Buffer.from('img')),
    comments: jest.fn().mockResolvedValue([]),
  };
  const reporter = { report: jest.fn() };
  const host = { pullRequestComments: jest.fn().mockResolvedValue([]) };
  class TestPoller extends JiraPoller {
    protected client() {
      return client as unknown as JiraClient;
    }
    protected host() {
      return { repository: 'example/demo', host: host as any };
    }
  }
  const orchestrator = new OrchestratorService(db, new TenantRegistry());
  return {
    client,
    reporter,
    host,
    orchestrator,
    poller: new TestPoller(db, orchestrator, reporter as any),
  };
}
test('a parent with sub-tasks becomes one delivery: open sub-tasks in card order', async () => {
  const x = setup([parent, subtask('1', 'DEMO-101', 'Migrations')]);
  await x.poller.poll(acme(), cloud());
  // The sub-task matched by the JQL was skipped: only the parent is a task.
  expect(await db.getRepository(Task).count()).toBe(1);
  const issue = await db.getRepository(Issue).findOneByOrFail({ externalKey: 'DEMO-100' });
  // Embedded images keep their file name, matching /attachments/<name>.
  expect(issue.body).toBe('Regras RN01..RN08\n\n[anexo: tela-admin.png]');
  const steps = issue.meta!.steps!;
  expect(steps.map((s) => [s.key, s.title, s.body])).toEqual([
    ['DEMO-101', 'Migrations', 'Detalhes de DEMO-101'],
    ['DEMO-103', 'Endpoint de recusa', 'Detalhes de DEMO-103'],
  ]);
  // Step 0 files travel with the task; later steps keep theirs for their revision.
  expect(issue.attachments!.map((a) => a.name)).toEqual(['tela-admin.png', 'sub-DEMO-101/erd.png']);
  expect(steps[1].attachments.map((a) => a.name)).toEqual(['api.png']);
  const dir = attachmentsDir('acme', 'jira', '60401');
  expect(await readFile(`${dir}/sub-DEMO-101/erd.png`, 'utf8')).toBe('img');
  expect(await readFile(`${dir}/rev-${steps[1].revisionId}/api.png`, 'utf8')).toBe('img');
  expect(
    x.reporter.report.mock.calls.map((c) => [c[1].externalKey, c[2].type, c[2].steps]),
  ).toEqual([
    ['DEMO-100', 'accepted', ['DEMO-101', 'DEMO-103']],
    ['DEMO-101', 'step-started', undefined],
  ]);
});
test('separate mode keeps every card, sub-tasks included, as its own task', async () => {
  const x = setup([subtask('1', 'DEMO-101', 'Migrations')]);
  await x.poller.poll(acme(), { ...cloud(), subtasks: 'separate' });
  expect(await db.getRepository(Task).count()).toBe(1);
});
test('sub-task steps queue one at a time, stop on failure and never count as revisions', async () => {
  const x = setup([parent]);
  await x.poller.poll(acme(), cloud());
  const task = await db.getRepository(Task).findOneByOrFail({});
  await db.getRepository(Task).update(task.id, { status: 'SUCCESS' });
  await db.getRepository(PullRequest).save({
    taskId: task.id,
    host: 'gh',
    externalId: '1',
    number: 9,
    title: 't',
    url: 'u',
    branch: 'b',
    baseBranch: 'main',
    state: 'open',
  });
  const first = await x.orchestrator.nextStep(task);
  expect(first).toMatchObject({ state: 'queued', index: 1, step: { key: 'DEMO-103' } });
  const revision = await db.getRepository(Revision).findOneByOrFail({});
  const issue = await db.getRepository(Issue).findOneByOrFail({ externalKey: 'DEMO-100' });
  expect(revision).toMatchObject({
    id: issue.meta!.steps![1].revisionId,
    origin: 'jira-subtask',
    externalKey: 'DEMO-103',
    title: 'Endpoint de recusa',
    externalId: 'jira-subtask:3',
  });
  // Idempotent while the step runs, and blocked while it is failed.
  expect(await x.orchestrator.nextStep(task)).toEqual({ state: 'waiting' });
  await db.getRepository(Revision).update(revision.id, { status: 'FAILED' });
  expect(await x.orchestrator.nextStep(task)).toEqual({ state: 'waiting' });
  await db.getRepository(Revision).update(revision.id, { status: 'SUCCESS' });
  expect(await x.orchestrator.nextStep(task)).toMatchObject({ state: 'complete' });
  expect(await db.getRepository(Revision).count()).toBe(1);
});
test('reviewer comments on a card in Change request become one revision, once', async () => {
  const x = setup([{ ...parent, fields: { ...parent.fields, subtasks: [] } }]);
  await x.poller.poll(acme(), cloud());
  const task = await db.getRepository(Task).findOneByOrFail({});
  await db.getRepository(Task).update(task.id, { status: 'SUCCESS' });
  await db.getRepository(PullRequest).save({
    taskId: task.id,
    host: 'gh',
    externalId: '1',
    number: 9,
    title: 't',
    url: 'u',
    branch: 'b',
    baseBranch: 'main',
    state: 'open',
  });
  x.client.search
    .mockReset()
    .mockImplementation(async (_max?: number, jql?: string) =>
      jql?.includes('Change request') ? [parent] : [],
    );
  x.client.comments.mockResolvedValue([
    {
      id: '30',
      created: '2026-10-01',
      author: 'Flavia',
      body: doc('O modal precisa de dupla confirmação'),
    },
    {
      id: '20',
      created: '2026-09-30',
      author: 'Pat',
      body: doc('AI Dev Team abriu um draft PR...'),
    },
    { id: '10', created: '2026-09-29', author: 'Flavia', body: doc('comentário antigo') },
  ]);
  // An earlier comment was already processed.
  await db
    .getRepository(Issue)
    .update({ externalKey: 'DEMO-100' }, { meta: { lastCommentId: '15' } });
  x.reporter.report.mockClear();
  await x.poller.poll(acme(), cloud());
  expect(x.client.search.mock.calls.at(-1)![1]).toBe(
    'key in (DEMO-100) AND status = "Change request"',
  );
  const revisions = await db.getRepository(Revision).find({});
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    origin: 'jira-change-request',
    requestedBy: 'Flavia',
    externalId: 'jira-cr:60401:30:0',
  });
  expect(revisions[0].instructions).toContain('O modal precisa de dupla confirmação');
  expect(revisions[0].instructions).not.toContain('AI Dev Team');
  expect(revisions[0].instructions).not.toContain('comentário antigo');
  expect(x.reporter.report).toHaveBeenCalledWith(
    expect.anything(),
    { source: 'jira', externalKey: 'DEMO-100' },
    { type: 'change-request', revision: 1 },
  );
  // Same comments on the next poll: nothing new.
  await x.poller.poll(acme(), cloud());
  expect(await db.getRepository(Revision).count()).toBe(1);
});
test('the reporter moves the right card at each moment of the delivery', async () => {
  const jira = { comment: jest.fn(), transition: jest.fn().mockResolvedValue(true) };
  class TestReporter extends SourceReporter {
    protected jira() {
      return jira as unknown as JiraClient;
    }
  }
  const reporter = new TestReporter();
  const on = (key: string, event: SourceEvent) =>
    reporter.report(acme(), { source: 'jira', externalKey: key }, event);
  await on('DEMO-101', { type: 'step-started' });
  await on('DEMO-101', { type: 'step-done', prUrl: 'https://pr/9', commit: 'abcdef1234' });
  await on('DEMO-100', { type: 'pr-opened', prUrl: 'https://pr/9', remaining: 2 });
  await on('DEMO-100', { type: 'completed', prUrl: 'https://pr/9' });
  await on('DEMO-100', { type: 'change-request', revision: 3 });
  await on('DEMO-100', { type: 'revised', prUrl: 'https://pr/9', commit: '1234567abc' });
  expect(jira.transition.mock.calls).toEqual([
    ['DEMO-101', 'In Progress'],
    ['DEMO-101', 'In Review'],
    ['DEMO-100', 'In Review'],
    ['DEMO-100', 'In Progress'],
    ['DEMO-100', 'In Review'],
  ]);
  expect(jira.comment.mock.calls.map((c) => c[1])).toEqual([
    expect.stringContaining('commit abcdef1'),
    expect.stringContaining('faltam 2 sub-tarefa(s)'),
    expect.stringContaining('concluiu todas as sub-tarefas'),
    expect.stringContaining('revisão #3'),
    expect.stringContaining('commit 1234567'),
  ]);
  // Every comment we write is recognizable, so change requests never read our own.
  for (const [, text] of jira.comment.mock.calls) expect(text.startsWith('AI Dev Team')).toBe(true);
});
test('branch-per-subtask: one stacked branch and PR per sub-task, into the story branch', async () => {
  const x = setup([parent, subtask('1', 'DEMO-101', 'Migrations')]);
  const source = { ...cloud(), subtasks: 'branch-per-subtask' as const };
  await x.poller.poll(acme(), source);
  // The story has no task of its own; its first open sub-task does.
  const first = await db.getRepository(Task).findOneOrFail({ where: {} });
  const issue = await db.getRepository(Issue).findOneByOrFail({ id: first.issueId });
  expect(issue.externalKey).toBe('DEMO-101');
  const story = issue.meta!.story!;
  expect(story.branch).toBe('ai/task-story-60401');
  expect(issue.meta).toMatchObject({
    baseRef: story.branch,
    prTarget: story.branch,
    ensureBase: true,
    stepIndex: 0,
  });
  expect(story.steps.map((s) => s.key)).toEqual(['DEMO-101', 'DEMO-103']);
  // Each sub-task holds its own files plus the story's, under story/.
  expect(issue.attachments!.map((a) => a.name)).toEqual(['story/tela-admin.png', 'erd.png']);
  expect(
    await readFile(`${attachmentsDir('acme', 'jira', '3')}/story/tela-admin.png`, 'utf8'),
  ).toBe('img');
  expect(
    x.reporter.report.mock.calls.map((c) => [c[1].externalKey, c[2].type, c[2].stacked]),
  ).toEqual([
    ['DEMO-100', 'accepted', true],
    ['DEMO-101', 'step-started', undefined],
  ]);
  // Polling again takes nothing new: the story is already being delivered.
  await x.poller.poll(acme(), source);
  expect(await db.getRepository(Task).count()).toBe(1);
  // The next sub-task starts from the previous branch and still merges into the story branch.
  const next = await x.orchestrator.nextStackedStep(first);
  expect(next.state).toBe('queued');
  const second = (next as { task: Task }).task;
  const nextIssue = await db.getRepository(Issue).findOneByOrFail({ id: second.issueId });
  expect(nextIssue.externalKey).toBe('DEMO-103');
  expect(nextIssue.url).toBe(`${cloud().baseUrl}/browse/DEMO-103`);
  expect(nextIssue.meta).toMatchObject({
    baseRef: first.branch,
    prTarget: story.branch,
    stepIndex: 1,
  });
  expect(nextIssue.meta!.ensureBase).toBeUndefined();
  expect((await x.orchestrator.nextStackedStep(second)).state).toBe('complete');
});
test('code review comments on the PR (lines of code included) join the revision, once', async () => {
  const x = setup([{ ...parent, fields: { ...parent.fields, subtasks: [] } }]);
  await x.poller.poll(acme(), cloud());
  const task = await db.getRepository(Task).findOneByOrFail({});
  await db.getRepository(Task).update(task.id, { status: 'SUCCESS' });
  await db.getRepository(PullRequest).save({
    taskId: task.id,
    host: 'gh',
    externalId: '1',
    number: 9,
    title: 't',
    url: 'u',
    branch: 'b',
    baseBranch: 'main',
    state: 'open',
  });
  x.client.search
    .mockReset()
    .mockImplementation(async (_max?: number, jql?: string) =>
      jql?.includes('Change request') ? [parent] : [],
    );
  // No new comment on the card: the review happened on the PR.
  x.client.comments.mockResolvedValue([]);
  x.host.pullRequestComments.mockResolvedValue([
    {
      id: '501',
      author: 'Flavia',
      body: 'Falta validar o motivo vazio',
      createdAt: '2026-10-03T10:00:00Z',
      path: 'src/Core/Appraisal/Refuse.php',
      line: 42,
    },
    {
      id: '502',
      author: 'Bot',
      body: 'AI Dev Team aplicou a revisão #1',
      createdAt: '2026-10-03T10:01:00Z',
    },
    { id: '503', author: 'Joao', body: 'Renomeie o teste', createdAt: '2026-10-03T10:02:00Z' },
    // A pipeline bot: ignored unless the project opts in (pullRequest.botComments).
    {
      id: '504',
      author: 'Sherlock',
      body: 'Relatório de qualidade...',
      createdAt: '2026-10-03T10:01:30Z',
      bot: true,
    },
  ]);
  await x.poller.poll(acme(), cloud());
  expect(x.host.pullRequestComments).toHaveBeenLastCalledWith('example/demo', 9, undefined);
  const [revision] = await db.getRepository(Revision).find({});
  expect(revision).toMatchObject({
    origin: 'jira-change-request',
    requestedBy: 'Flavia, Joao',
    externalId: 'jira-cr:60401:0:2026-10-03T10:02:00Z',
  });
  expect(revision.instructions).toBe(
    'Comentários do code review no PR #9:\n' +
      '- Flavia em `src/Core/Appraisal/Refuse.php`, linha 42: Falta validar o motivo vazio\n' +
      '- Joao: Renomeie o teste',
  );
  // Next poll reads only what came after the newest comment already used.
  await db.getRepository(Revision).update(revision.id, { status: 'SUCCESS' });
  await x.poller.poll(acme(), cloud());
  expect(x.host.pullRequestComments).toHaveBeenLastCalledWith(
    'example/demo',
    9,
    '2026-10-03T10:02:00Z',
  );
});
test('a PR that cannot be read defers the card instead of applying half the review', async () => {
  const x = setup([{ ...parent, fields: { ...parent.fields, subtasks: [] } }]);
  await x.poller.poll(acme(), cloud());
  const task = await db.getRepository(Task).findOneByOrFail({});
  await db.getRepository(Task).update(task.id, { status: 'SUCCESS' });
  await db.getRepository(PullRequest).save({
    taskId: task.id,
    host: 'gh',
    externalId: '1',
    number: 9,
    title: 't',
    url: 'u',
    branch: 'b',
    baseBranch: 'main',
    state: 'open',
  });
  x.client.search
    .mockReset()
    .mockImplementation(async (_max?: number, jql?: string) =>
      jql?.includes('Change request') ? [parent] : [],
    );
  x.client.comments.mockResolvedValue([
    { id: '30', created: '2026-10-01', author: 'Flavia', body: doc('ver comentários no PR') },
  ]);
  x.host.pullRequestComments.mockRejectedValue(new Error('Bitbucket 503'));
  await x.poller.poll(acme(), cloud());
  expect(await db.getRepository(Revision).count()).toBe(0);
  const issue = await db.getRepository(Issue).findOneByOrFail({ externalKey: 'DEMO-100' });
  expect(issue.meta?.lastCommentId).toBeUndefined();
});
test('starting from a card key gives the task, or why not', async () => {
  const x = setup([]);
  const plain = { ...parent, fields: { ...parent.fields, subtasks: [] } };
  x.client.issue.mockImplementation(async (key: string) =>
    key === 'DEMO-100' ? plain : subtask('1', 'DEMO-101', 'Migrations'),
  );
  const first = await x.poller.startFromKey('acme', 'DEMO-100');
  expect(first).toEqual({ taskId: expect.any(String) });
  // Again: nothing new, the same task.
  expect(await x.poller.startFromKey('acme', 'DEMO-100')).toEqual({
    skipped: 'Esse card já tem tarefa',
    taskId: (first as { taskId: string }).taskId,
  });
  expect(await db.getRepository(Task).count()).toBe(1);
  expect(await x.poller.startFromKey('acme', 'DEMO-101')).toEqual({
    skipped: 'O card é uma sub-tarefa: inicie pela história',
  });
  await expect(x.poller.startFromKey('globex', 'X-1')).rejects.toThrow('Empresa sem fonte Jira');
});
test('starting the same card twice at once runs one after the other (finding 6)', async () => {
  const x = setup([]);
  const plain = { ...parent, fields: { ...parent.fields, subtasks: [] } };
  x.client.issue.mockImplementation(async () => plain);
  const [a, b] = await Promise.all([
    x.poller.startFromKey('acme', 'DEMO-100'),
    x.poller.startFromKey('acme', 'DEMO-100'),
  ]);
  const results = [a, b];
  expect(results.filter((r) => !('skipped' in r))).toHaveLength(1);
  expect(results.find((r) => 'skipped' in r)).toEqual({
    skipped: 'Esse card já tem tarefa',
    taskId: (results.find((r) => !('skipped' in r)) as { taskId: string }).taskId,
  });
  expect(await db.getRepository(Task).count()).toBe(1);
});
describe('one sub-task started on its own (front: Card do Jira)', () => {
  const story: JiraIssue = {
    ...parent,
    fields: {
      ...parent.fields,
      description: doc('Figma: https://www.figma.com/design/AbCdEfGhIjKl/x?node-id=1-2'),
      subtasks: [
        {
          id: '1',
          key: 'DEMO-101',
          fields: { summary: 'Migrations', status: { statusCategory: { key: 'done' } } },
        },
        {
          id: '3',
          key: 'DEMO-103',
          fields: { summary: 'Tela', status: { statusCategory: { key: 'new' } } },
        },
      ],
    },
  };
  const sub: JiraIssue = {
    ...subtask('3', 'DEMO-103', 'Tela de recusa', ['print.png']),
    fields: {
      ...subtask('3', 'DEMO-103', 'Tela de recusa', ['print.png']).fields,
      parent: { key: 'DEMO-100' },
    },
  };
  function single(branches: Record<string, string>) {
    const x = setup([]);
    x.client.issue.mockImplementation(async (key: string) => (key === 'DEMO-100' ? story : sub));
    (x.host as any).branchDate = jest.fn(async (_repo: string, name: string) => branches[name]);
    const tenant = acme();
    const source = { ...cloud(), subtasks: 'branch-per-subtask' as const };
    const projects = tenant.projects.map((p) => ({ ...p, branch: 'feature/{key}' }));
    useTenants([
      { ...tenant, projects, sources: tenant.sources.map((s) => (s.id === 'jira' ? source : s)) },
      ...tenants().filter((t) => t.id !== 'acme'),
    ]);
    return x;
  }
  afterEach(() => useTenants(undefined));
  test('lists the story branch and the existing sibling branches as bases', async () => {
    const x = single({ 'feature/DEMO-100': '2026-10-05', 'feature/DEMO-101': '2026-10-06' });
    expect(await x.poller.subtaskBases('acme', 'DEMO-103')).toEqual({
      subtask: true,
      story: 'DEMO-100',
      storyBranch: 'feature/DEMO-100',
      ownBranch: 'feature/DEMO-103',
      ownExists: false,
      bases: [
        { branch: 'feature/DEMO-100', label: 'História DEMO-100', date: '2026-10-05' },
        { branch: 'feature/DEMO-101', label: 'DEMO-101 — Migrations', date: '2026-10-06' },
      ],
    });
    x.client.issue.mockImplementation(async () => story);
    expect(await x.poller.subtaskBases('acme', 'DEMO-100')).toEqual({ subtask: false });
  });
  test('starts only that sub-task: chosen base, PR to the story branch, story as context', async () => {
    const x = single({ 'feature/DEMO-100': '2026-10-05', 'feature/DEMO-101': '2026-10-06' });
    const result = await x.poller.startFromKey('acme', 'DEMO-103', 'feature/DEMO-101');
    expect(result).toEqual({ taskId: expect.any(String) });
    expect(await db.getRepository(Task).count()).toBe(1);
    const issue = await db.getRepository(Issue).findOneByOrFail({ externalKey: 'DEMO-103' });
    expect(issue.meta).toMatchObject({
      baseRef: 'feature/DEMO-101',
      prTarget: 'feature/DEMO-100',
      single: true,
      stepIndex: 0,
      story: { key: 'DEMO-100', branch: 'feature/DEMO-100', steps: [{ key: 'DEMO-103' }] },
    });
    expect(issue.meta!.ensureBase).toBeFalsy();
    // The story text (with its Figma link) and its prints travel with the sub-task.
    expect(issue.meta!.story!.body).toContain('figma.com/design/AbCdEfGhIjKl');
    expect(issue.attachments!.map((a) => a.name).sort()).toEqual([
      'print.png',
      'story/tela-admin.png',
    ]);
    expect(x.reporter.report).toHaveBeenCalledWith(
      expect.anything(),
      { source: 'jira', externalKey: 'DEMO-103' },
      expect.objectContaining({ type: 'accepted' }),
    );
  });
  test('refuses: own branch already exists, base not allowed, no base, no story branch', async () => {
    const taken = single({ 'feature/DEMO-100': '1', 'feature/DEMO-103': '2' });
    expect(await taken.poller.startFromKey('acme', 'DEMO-103', 'feature/DEMO-100')).toEqual({
      skipped: 'Já existe a branch feature/DEMO-103 no repositório: a sub-tarefa já foi começada',
    });
    const stranger = single({ 'feature/DEMO-100': '1' });
    expect(await stranger.poller.startFromKey('acme', 'DEMO-103', 'master')).toEqual({
      skipped: 'A branch master não é a da história nem a de uma sub-tarefa irmã',
    });
    expect(await stranger.poller.startFromKey('acme', 'DEMO-103')).toEqual({
      skipped: 'Escolha de qual branch a sub-tarefa começa',
    });
    const orphan = single({});
    expect(await orphan.poller.startFromKey('acme', 'DEMO-103', 'feature/DEMO-100')).toEqual({
      skipped: 'A branch da história (feature/DEMO-100) não existe no repositório',
    });
    expect(await db.getRepository(Task).count()).toBe(0);
  });
});
