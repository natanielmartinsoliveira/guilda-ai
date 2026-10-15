import { createHmac } from 'node:crypto';
import { BitbucketHost } from '../src/hosts/bitbucket.host';
import { bitbucketWebhook } from '../src/sources/bitbucket.source';
import { loadTenants, tenants, useTenants } from '../src/tenants/tenants';
import { redact } from '../src/config';
afterEach(() => jest.restoreAllMocks());
const yaml = (host = '{ id: bb, type: bitbucket, token: bb-access-token-123 }') => `
tenants:
  - id: initrode
    name: Initrode
    git: { authorName: B, authorEmail: b@initrode.test }
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [${host}]
    sources:
      - { id: bitbucket, type: bitbucket, webhookSecret: bb-webhook-secret-123456 }
    projects:
      - { id: portal, host: bb, repository: vandelay-workspace/portal, test: [x] }
`;
const pr = (id = 5) => ({
  id,
  title: 'AI: API-1 x',
  state: 'OPEN',
  links: {
    html: { href: `https://bitbucket.org/vandelay-workspace/portal/pull-requests/${id}` },
  },
});
describe('BitbucketHost', () => {
  const input = { branch: 'ai/task-1', base: 'main', title: 'AI: API-1 x', body: 'body' };
  test('clone URL and git auth use the documented static usernames', () => {
    const access = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
    const api = new BitbucketHost('bb', { auth: 'api-token', email: 'a@b.c', token: 'tok' });
    expect(access.cloneUrl('ws/repo')).toBe('https://bitbucket.org/ws/repo.git');
    expect(access.gitAuthHeader()).toBe(
      `Authorization: Basic ${Buffer.from('x-token-auth:tok').toString('base64')}`,
    );
    expect(api.gitAuthHeader()).toBe(
      `Authorization: Basic ${Buffer.from('x-bitbucket-api-token-auth:tok').toString('base64')}`,
    );
  });
  test('PR comments: open ones only, oldest first, across pages; bots and replies marked', async () => {
    const base = 'https://api.bitbucket.org/2.0/repositories/ws/repo';
    const c = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      created_on: `2026-10-03T10:0${id % 10}:00+00:00`,
      content: { raw: `texto ${id}` },
      user: { display_name: `Pessoa ${id}`, type: 'user' },
      ...extra,
    });
    const pages: Record<string, unknown> = {
      [`${base}/pullrequests/7/comments?pagelen=100`]: {
        values: [
          c(3, { inline: { path: 'src/A.php', from: null, to: 42 } }),
          c(1, { deleted: true }),
          c(2, { pending: true }),
        ],
        next: `${base}/pullrequests/7/comments?pagelen=100&page=2`,
      },
      [`${base}/pullrequests/7/comments?pagelen=100&page=2`]: {
        values: [
          c(4, { resolution: { type: 'comment_resolution' } }),
          c(5, { user: { display_name: 'Sherlock', type: 'app_user' } }),
          c(6, { parent: { id: 3 } }),
        ],
      },
    };
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const body = pages[String(url)];
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
    });
    const host = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
    const list = await host.pullRequestComments('ws/repo', 7);
    expect(list.map((x) => [x.id, x.path, x.line, x.bot, x.reply])).toEqual([
      ['3', 'src/A.php', 42, false, false],
      ['5', undefined, undefined, true, false],
      ['6', undefined, undefined, false, true],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // "since" leaves out what was already handled.
    expect(
      (await host.pullRequestComments('ws/repo', 7, '2026-10-03T10:05:00+00:00')).map((x) => x.id),
    ).toEqual(['6']);
  });
  test('REST auth: Bearer for access tokens, e-mail Basic for API tokens', async () => {
    const http = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ values: [pr()] })));
    await new BitbucketHost('bb', { auth: 'access-token', token: 'tok' }).ensurePullRequest(
      'ws/repo',
      input,
    );
    await new BitbucketHost('bb', {
      auth: 'api-token',
      email: 'a@b.c',
      token: 'tok',
    }).ensurePullRequest('ws/repo', input);
    const auth = http.mock.calls.map(
      (c) => (c[1]!.headers as Record<string, string>).Authorization,
    );
    expect(auth).toEqual(['Bearer tok', `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`]);
    const url = decodeURIComponent(String(http.mock.calls[0][0]));
    expect(url).toContain('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?');
    expect(url).toContain('q=source.branch.name="ai/task-1"');
    expect(url).toContain('state=MERGED');
  });
  test('reuses an existing PR, creates a draft otherwise, recovers ambiguous creation', async () => {
    const host = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
    const request = jest.spyOn(host, 'request');
    request.mockResolvedValueOnce({ values: [pr(7)] });
    expect(await host.ensurePullRequest('ws/repo', input)).toMatchObject({ id: '7', number: 7 });
    request.mockResolvedValueOnce({ values: [] }).mockResolvedValueOnce(pr(8));
    const created = await host.ensurePullRequest('ws/repo', input);
    expect(created.url).toContain('/pull-requests/8');
    expect(request.mock.calls[2].slice(1)).toEqual([
      '/pullrequests',
      'POST',
      {
        title: input.title,
        description: 'body',
        source: { branch: { name: 'ai/task-1' } },
        destination: { branch: { name: 'main' } },
        draft: true,
        close_source_branch: false,
      },
    ]);
    request
      .mockResolvedValueOnce({ values: [] })
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce({ values: [pr(9)] });
    expect((await host.ensurePullRequest('ws/repo', input)).number).toBe(9);
  });
  test('comments on the PR with raw markdown', async () => {
    const host = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
    const request = jest.spyOn(host, 'request').mockResolvedValue(undefined);
    await host.commentOnPullRequest('ws/repo', 8, 'done');
    expect(request).toHaveBeenCalledWith('ws/repo', '/pullrequests/8/comments', 'POST', {
      content: { raw: 'done' },
    });
  });
  test('configuration: api-token needs the account e-mail', () => {
    expect(() =>
      loadTenants(yaml('{ id: bb, type: bitbucket, auth: api-token, token: x }'), {}),
    ).toThrow('api-token auth requires email');
  });
});
describe('Bitbucket "/ai" comments', () => {
  const [tenant] = loadTenants(yaml(), {});
  const source = tenant.sources[0];
  const payload = (raw: string, extra: Record<string, unknown> = {}) => ({
    repository: { full_name: 'vandelay-workspace/portal' },
    pullrequest: { id: 12 },
    comment: {
      id: 900,
      content: { raw },
      user: { account_id: 'acc-1', nickname: 'pat', display_name: 'Pat' },
      ...extra,
    },
  });
  const request = (
    body: unknown,
    event = 'pullrequest:comment_created',
    secret = 'bb-webhook-secret-123456',
  ) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {
      'x-event-key': event,
      'x-hub-signature': 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
    };
    return { rawBody, body, header: (name: string) => headers[name] };
  };
  test('turns a PR comment into a revision, with file and line for inline comments', () => {
    expect(bitbucketWebhook(tenant, source, request(payload('/ai use early return')))).toEqual({
      revision: {
        repository: 'vandelay-workspace/portal',
        prNumber: 12,
        instructions: 'use early return',
        requestedBy: 'pat',
        externalId: 'bitbucket-comment:900',
      },
    });
    const inline = bitbucketWebhook(
      tenant,
      source,
      request(payload('/ai rename this', { inline: { path: 'src/App.php', to: 42 } })),
    );
    expect(inline).toMatchObject({
      revision: { instructions: 'Comentário no arquivo src/App.php, linha 42:\nrename this' },
    });
  });
  test('rejects bad signatures, other repositories and users outside the allowlist', () => {
    expect(() =>
      bitbucketWebhook(
        tenant,
        source,
        request(payload('/ai x'), undefined, 'wrong-secret-1234567'),
      ),
    ).toThrow('Invalid signature');
    expect(() =>
      bitbucketWebhook(
        tenant,
        source,
        request({ ...payload('/ai x'), repository: { full_name: 'other/repo' } }),
      ),
    ).toThrow('Repository not allowed');
    expect(() =>
      bitbucketWebhook(
        tenant,
        { ...source, allowedUsers: ['someone-else'] } as any,
        request(payload('/ai x')),
      ),
    ).toThrow('Comment author not allowed');
  });
  test('ignores other events, conversation and deleted comments', () => {
    for (const r of [
      request(payload('/ai x'), 'pullrequest:updated'),
      request(payload('LGTM')),
      request(payload('/ai x', { deleted: true })),
      request(payload('/ai')),
    ])
      expect(bitbucketWebhook(tenant, source, r)).toMatchObject({ ignored: true });
  });
  test('every Basic encoding of a Bitbucket token is masked in logs', () => {
    const previous = tenants();
    useTenants(loadTenants(yaml(), {}));
    try {
      const encoded = Buffer.from('x-token-auth:bb-access-token-123').toString('base64');
      expect(redact(`Authorization: Basic ${encoded}`)).toBe('Authorization: Basic [REDACTED]');
      expect(redact('bb-access-token-123')).toBe('[REDACTED]');
    } finally {
      useTenants(previous);
    }
  });
});
