import { DataSource } from 'typeorm';
import { item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Issue, PullRequest, Revision, Task } from '../src/database/entities';
import { GitlabReviewPoller } from '../src/sources/gitlab-review.poller';
import { loadTenants, useTenants } from '../src/tenants/tenants';
import { coderTenantYaml, CODER_PROJECT } from './fixtures/coder-tenant';
import type { ReviewComment } from '../src/hosts/code-host';
let db: DataSource;
afterEach(async () => {
  useTenants(undefined);
  await db.destroy();
});
const note = (id: number, body: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id: String(id),
  author: `Pessoa ${id}`,
  authorId: `p${id}`,
  body,
  createdAt: `2026-10-10T10:0${id}:00.000Z`,
  ...extra,
});
async function setup({ allowed = '', state = 'opened', comments = [] as ReviewComment[] } = {}) {
  db = await (await import('./db')).database();
  const yaml = coderTenantYaml(CODER_PROJECT.replace('rehearsal', 'draft')).replace(
    'token: glpat-123456',
    `token: glpat-123456${allowed ? `\n        allowedUsers: [${allowed}]` : ''}`,
  );
  const [tenant] = loadTenants(yaml);
  useTenants([tenant]);
  const orchestrator = new OrchestratorService(db, new TenantRegistry());
  const task = await orchestrator.accept('initech', { ...item, project: 'svc' });
  await db
    .getRepository(Task)
    .update(task.id, { status: 'SUCCESS', result: { baseSha: 'a'.repeat(40) } as any });
  await db.getRepository(PullRequest).save({
    taskId: task.id,
    host: 'gl',
    externalId: '912',
    number: 12,
    title: 'Draft: x',
    url: 'https://git.example.com/shop/svc/-/merge_requests/12',
    branch: task.branch,
    baseBranch: 'homolog',
    state: 'opened',
  });
  const host = {
    pullRequestComments: jest.fn(async () => comments),
    mergeRequestState: jest.fn(async () => state),
  };
  const poller = new (class extends GitlabReviewPoller {
    protected gitlab() {
      return host as any;
    }
  })(db, orchestrator);
  return { poller, tenant, task, host };
}
const revisions = (taskId: string) => db.getRepository(Revision).findBy({ taskId });
test('a "/ai" comment on an open MR becomes one revision, with the line when there is one', async () => {
  const x = await setup({
    comments: [
      note(1, 'parece bom'),
      note(2, '/ai renomeie a variável', { path: 'src/a.php', line: 10 }),
    ],
  });
  await x.poller.poll(x.tenant);
  await x.poller.poll(x.tenant);
  const list = await revisions(x.task.id);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    origin: 'gitlab-comment',
    externalId: 'gitlab-note:2',
    requestedBy: 'p2',
    instructions: 'Comentário no arquivo src/a.php, linha 10:\nrenomeie a variável',
  });
  const issue = await db.getRepository(Issue).findOneByOrFail({ id: x.task.issueId });
  expect(issue.meta?.gitlabCommentsAt).toBe('2026-10-10T10:02:00.000Z');
  expect(x.host.pullRequestComments).toHaveBeenLastCalledWith(
    'shop/shop-orders',
    12,
    '2026-10-10T10:02:00.000Z',
  );
});
test('only allowed users trigger', async () => {
  const x = await setup({ allowed: 'p3', comments: [note(2, '/ai x'), note(3, '/ai y')] });
  await x.poller.poll(x.tenant);
  const list = await revisions(x.task.id);
  expect(list.map((r) => r.instructions)).toEqual(['y']);
});
test('a merged or closed MR is not read (focus 5) and its state is recorded', async () => {
  const x = await setup({ state: 'merged', comments: [note(2, '/ai x')] });
  await x.poller.poll(x.tenant);
  expect(x.host.pullRequestComments).not.toHaveBeenCalled();
  expect(await revisions(x.task.id)).toEqual([]);
  expect((await db.getRepository(PullRequest).findOneByOrFail({ taskId: x.task.id })).state).toBe(
    'merged',
  );
});
test('an empty "/ai" and plain conversation are ignored', async () => {
  const x = await setup({ comments: [note(2, '/ai'), note(3, 'pode usar /ai depois')] });
  await x.poller.poll(x.tenant);
  expect(await revisions(x.task.id)).toEqual([]);
});
