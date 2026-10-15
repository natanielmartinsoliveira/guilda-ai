import { createHmac } from 'node:crypto';
import { WebhookController } from '../src/webhooks/webhook.controller';
import { event } from './db';
function request(
  payload: unknown,
  type = 'issues',
  secret = process.env.ACME_WEBHOOK_SECRET!,
  signature?: string,
) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    body: payload,
    rawBody,
    get: (name: string) =>
      name === 'x-github-event'
        ? type
        : name === 'content-type'
          ? 'application/json'
          : (signature ?? 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')),
  } as any;
}
const accept = jest.fn().mockResolvedValue({ id: 'task-id', status: 'PENDING' });
const controller = new WebhookController({ accept } as any);
beforeEach(() => accept.mockClear());
test('accepts issue for the tenant and returns queued identity', async () => {
  expect(await controller.receive('acme', 'github', request(event))).toEqual({
    taskId: 'task-id',
    status: 'PENDING',
  });
  expect(accept).toHaveBeenCalledWith('acme', {
    source: 'github',
    externalId: '123',
    key: '#7',
    title: event.issue.title,
    body: event.issue.body,
    url: event.issue.html_url,
    project: 'demo',
    closingRef: 'Closes #7',
  });
});
test('rejects invalid signature before orchestration', async () => {
  await expect(
    controller.receive('acme', 'github', request(event, 'issues', undefined, 'sha256=00')),
  ).rejects.toThrow('Invalid signature');
  expect(accept).not.toHaveBeenCalled();
});
test('rejects a payload signed with another tenant secret', async () => {
  await expect(
    controller.receive(
      'acme',
      'github',
      request(event, 'issues', process.env.GLOBEX_WEBHOOK_SECRET),
    ),
  ).rejects.toThrow('Invalid signature');
});
test('a tenant cannot schedule work on another tenant repository', async () => {
  const globexRepo = {
    ...event,
    repository: {
      ...event.repository,
      name: 'site',
      full_name: 'globex/site',
      owner: { login: 'globex' },
    },
  };
  await expect(controller.receive('acme', 'github', request(globexRepo))).rejects.toThrow(
    'Repository not allowed',
  );
  expect(accept).not.toHaveBeenCalled();
});
test('unknown tenant or source is indistinguishable and never reaches orchestration', async () => {
  await expect(controller.receive('nobody', 'github', request(event))).rejects.toThrow('Not Found');
  await expect(controller.receive('acme', 'jira', request(event))).rejects.toThrow('Not Found');
  expect(accept).not.toHaveBeenCalled();
});
test('ignores unrelated events', async () => {
  expect(await controller.receive('acme', 'github', request({}, 'push'))).toEqual({
    ignored: true,
  });
  expect(accept).not.toHaveBeenCalled();
});
test('rejects another repository', async () => {
  await expect(
    controller.receive(
      'acme',
      'github',
      request({ ...event, repository: { ...event.repository, full_name: 'attacker/demo' } }),
    ),
  ).rejects.toThrow('Repository not allowed');
});
test('rejects untrusted author', async () => {
  await expect(
    controller.receive(
      'acme',
      'github',
      request({ ...event, issue: { ...event.issue, author_association: 'NONE' } }),
    ),
  ).rejects.toThrow('Issue author not allowed');
});
test('rejects malformed payload', async () => {
  await expect(controller.receive('acme', 'github', request({ action: 'opened' }))).rejects.toThrow(
    'Invalid issue payload',
  );
});
describe('"/ai" PR comments', () => {
  const comment = (body: string, over: Record<string, unknown> = {}) => ({
    action: 'created',
    repository: event.repository,
    issue: { number: 8, pull_request: { url: 'x' } },
    comment: {
      id: 555,
      body,
      author_association: 'MEMBER',
      user: { login: 'pat', type: 'User' },
      ...over,
    },
  });
  const requestRevision = jest.fn();
  const withRevisions = new WebhookController({ accept, requestRevision } as any);
  beforeEach(() => requestRevision.mockReset());
  test('turns "/ai ..." into a revision of the PR task', async () => {
    requestRevision.mockResolvedValue({ id: 'rev-1', number: 1, status: 'PENDING' });
    const r = await withRevisions.receive(
      'acme',
      'github',
      request(comment('/ai  use camelCase\nand add a test '), 'issue_comment'),
    );
    expect(r).toEqual({ revisionId: 'rev-1', number: 1, status: 'PENDING' });
    expect(requestRevision).toHaveBeenCalledWith(
      'acme',
      { repository: 'example/demo', prNumber: 8 },
      {
        instructions: 'use camelCase\nand add a test',
        requestedBy: 'pat',
        externalId: 'github-comment:555',
        origin: 'github-comment',
      },
    );
  });
  test('ignores conversation, issue comments, bots and empty commands', async () => {
    for (const payload of [
      comment('LGTM, but /ai could help'),
      { ...comment('/ai fix'), issue: { number: 8 } },
      comment('/ai fix', { user: { login: 'ai-dev-team[bot]', type: 'Bot' } }),
      comment('/ai'),
    ])
      expect(
        await withRevisions.receive('acme', 'github', request(payload, 'issue_comment')),
      ).toMatchObject({ ignored: true });
    expect(requestRevision).not.toHaveBeenCalled();
  });
  test('only allowed authors on the tenant repositories', async () => {
    await expect(
      withRevisions.receive(
        'acme',
        'github',
        request(comment('/ai fix', { author_association: 'NONE' }), 'issue_comment'),
      ),
    ).rejects.toThrow('Comment author not allowed');
    await expect(
      withRevisions.receive(
        'acme',
        'github',
        request(
          { ...comment('/ai fix'), repository: { ...event.repository, full_name: 'x/demo' } },
          'issue_comment',
        ),
      ),
    ).rejects.toThrow('Repository not allowed');
  });
  test('a rejected revision is acknowledged with its reason, not retried by GitHub', async () => {
    const { RevisionRejected } = await import('../src/tasks/orchestrator.service');
    requestRevision.mockRejectedValue(
      new RevisionRejected('not_ready', 'The task has no pull request yet'),
    );
    expect(
      await withRevisions.receive('acme', 'github', request(comment('/ai fix'), 'issue_comment')),
    ).toEqual({ ignored: true, reason: 'The task has no pull request yet' });
  });
  test('createFromIssues: false keeps revisions but ignores new issues', async () => {
    const tenants = await import('../src/tenants/tenants');
    const acme = tenants.findTenant('acme')!;
    const spy = jest.spyOn(tenants, 'findTenant').mockReturnValue({
      ...acme,
      sources: acme.sources.map((s) =>
        s.type === 'github-issues' ? { ...s, createFromIssues: false } : s,
      ),
    });
    try {
      expect(await withRevisions.receive('acme', 'github', request(event))).toEqual({
        ignored: true,
      });
      requestRevision.mockResolvedValue({ id: 'r', number: 1, status: 'PENDING' });
      expect(
        await withRevisions.receive('acme', 'github', request(comment('/ai x'), 'issue_comment')),
      ).toMatchObject({ revisionId: 'r' });
    } finally {
      spy.mockRestore();
    }
  });
});
test('a form-encoded webhook is rejected with the fix, not silently ignored', async () => {
  const req = request(event);
  const get = req.get;
  req.get = (name: string) =>
    name === 'content-type' ? 'application/x-www-form-urlencoded' : get(name);
  await expect(controller.receive('acme', 'github', req)).rejects.toThrow(
    'Set the webhook Content type to application/json',
  );
  expect(accept).not.toHaveBeenCalled();
});
describe('"Request changes" reviews', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    action: 'submitted',
    repository: event.repository,
    pull_request: { number: 8 },
    review: {
      id: 777,
      body: 'Faltou tratar o caso vazio.',
      state: 'changes_requested',
      author_association: 'MEMBER',
      user: { login: 'flavia', type: 'User' },
      ...over,
    },
  });
  const requestRevision = jest.fn();
  const lines = jest.fn();
  class TestController extends WebhookController {
    protected reviewComments(...args: unknown[]) {
      return lines(...args);
    }
  }
  const controller = new TestController({ accept, requestRevision } as any);
  beforeEach(() => {
    requestRevision.mockReset().mockResolvedValue({ id: 'rev-1', number: 1, status: 'PENDING' });
    lines.mockReset().mockResolvedValue([
      {
        id: '1',
        author: 'flavia',
        body: 'Use o enum aqui',
        createdAt: 'x',
        path: 'src/a.ts',
        line: 12,
      },
      { id: '2', author: 'joao', body: 'concordo', createdAt: 'y', reply: true },
    ]);
  });
  test('the review text and its line comments become one revision', async () => {
    const r = await controller.receive('acme', 'github', request(review(), 'pull_request_review'));
    expect(r).toEqual({ revisionId: 'rev-1', number: 1, status: 'PENDING' });
    expect(lines).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acme' }),
      'example/demo',
      8,
      777,
    );
    expect(requestRevision).toHaveBeenCalledWith(
      'acme',
      { repository: 'example/demo', prNumber: 8 },
      {
        origin: 'github-review',
        requestedBy: 'flavia',
        externalId: 'github-review:777',
        instructions:
          'Comentário geral da revisão:\nFaltou tratar o caso vazio.\n\n' +
          'Comentários nas linhas do código:\n' +
          '- flavia em `src/a.ts`, linha 12: Use o enum aqui\n' +
          '- ↳ resposta de joao: concordo',
      },
    );
  });
  test('approvals, comments-only reviews and bots never trigger work', async () => {
    for (const over of [
      { state: 'approved' },
      { state: 'commented' },
      { user: { login: 'x', type: 'Bot' } },
    ])
      expect(
        await controller.receive('acme', 'github', request(review(over), 'pull_request_review')),
      ).toEqual({ ignored: true });
    expect(requestRevision).not.toHaveBeenCalled();
  });
  test('untrusted reviewers are refused; an empty review is acknowledged and ignored', async () => {
    await expect(
      controller.receive(
        'acme',
        'github',
        request(review({ author_association: 'NONE' }), 'pull_request_review'),
      ),
    ).rejects.toThrow('Review author not allowed');
    lines.mockResolvedValue([]);
    expect(
      await controller.receive(
        'acme',
        'github',
        request(review({ body: null }), 'pull_request_review'),
      ),
    ).toEqual({ ignored: true, reason: 'Review requested changes without any comment' });
    expect(requestRevision).not.toHaveBeenCalled();
  });
});
