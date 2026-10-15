import { GitlabHost } from '../src/hosts/gitlab.host';
import { TaskError } from '../src/config';
afterEach(() => jest.restoreAllMocks());
const API = 'https://git.example.com/api/v4/projects/shop%2Fsvc';
const host = () =>
  new GitlabHost('gl', {
    baseUrl: 'https://git.example.com',
    sshUrl: 'ssh://git.example.com:2244',
    token: 'glpat-secret',
  });
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;
/** fetch answering by "METHOD url"; records the calls. */
function gitlab(routes: Record<string, Reply | Reply[]>) {
  const calls: { method: string; url: string; body?: unknown; headers: Record<string, string> }[] =
    [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string>,
    });
    let reply = routes[`${method} ${url}`];
    if (Array.isArray(reply)) reply = reply.length > 1 ? reply.shift()! : reply[0];
    if (!reply) return new Response('not found', { status: 404 });
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  });
  return calls;
}
const mr = (iid = 12, state = 'opened') => ({
  id: 900 + iid,
  iid,
  title: 'Draft: 49145 - Fix',
  state,
  web_url: `https://git.example.com/shop/svc/-/merge_requests/${iid}`,
});
const FIND = `GET ${API}/merge_requests?source_branch=49145-fix&state=all&order_by=created_at&sort=desc`;
const input = {
  branch: '49145-fix',
  base: 'homolog',
  title: '49145 - Fix',
  body: 'corpo',
  draft: true,
  reviewers: ['pat.doe'],
};
test('creates a draft MR with reviewers as ids, keeping the source branch', async () => {
  const calls = gitlab({
    [FIND]: { body: [] },
    'GET https://git.example.com/api/v4/users?username=pat.doe': { body: [{ id: 77 }] },
    [`POST ${API}/merge_requests`]: { status: 201, body: mr() },
  });
  const pr = await host().ensurePullRequest('shop/svc', input);
  expect(pr).toEqual({
    id: '912',
    number: 12,
    title: 'Draft: 49145 - Fix',
    url: 'https://git.example.com/shop/svc/-/merge_requests/12',
    state: 'opened',
  });
  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.body).toEqual({
    source_branch: '49145-fix',
    target_branch: 'homolog',
    title: 'Draft: 49145 - Fix',
    description: 'corpo',
    reviewer_ids: [77],
    remove_source_branch: false,
  });
  expect(post.headers['PRIVATE-TOKEN']).toBe('glpat-secret');
});
test('a normal MR has no Draft prefix and no reviewers when none are set', async () => {
  const calls = gitlab({ [FIND]: { body: [] }, [`POST ${API}/merge_requests`]: { body: mr() } });
  await host().ensurePullRequest('shop/svc', { ...input, draft: false, reviewers: undefined });
  const post = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
  expect(post.title).toBe('49145 - Fix');
  expect(post.reviewer_ids).toEqual([]);
});
test('an MR of the branch in any state is reused, never recreated (focus 3)', async () => {
  const calls = gitlab({ [FIND]: { body: [mr(3, 'merged')] } });
  expect((await host().ensurePullRequest('shop/svc', input)).number).toBe(3);
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});
test('a lost POST response: the created MR is found before failing', async () => {
  gitlab({
    [FIND]: [{ body: [] }, { body: [mr(14)] }],
    'GET https://git.example.com/api/v4/users?username=pat.doe': { body: [{ id: 77 }] },
    [`POST ${API}/merge_requests`]: new Error('socket hang up'),
  });
  expect((await host().ensurePullRequest('shop/svc', input)).number).toBe(14);
});
test('an unknown reviewer stops the delivery with a clear, final error', async () => {
  gitlab({
    [FIND]: { body: [] },
    'GET https://git.example.com/api/v4/users?username=pat.doe': { body: [] },
  });
  await expect(host().ensurePullRequest('shop/svc', input)).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/Revisor pat.doe não encontrado/),
  });
});
test('review comments: open ones only, oldest first, across pages; lines, replies and bots', async () => {
  const note = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    body: `texto ${id}`,
    created_at: `2026-10-10T10:0${id}:00.000Z`,
    system: false,
    author: { username: `p${id}`, name: `Pessoa ${id}` },
    ...extra,
  });
  const page1 = [
    { id: 'a', notes: [note(5)] },
    { id: 'b', notes: [note(1, { system: true })] },
    {
      id: 'c',
      notes: [
        note(2, { resolvable: true, resolved: true }),
        note(6, { resolvable: true, resolved: true }),
      ],
    },
  ];
  const page2 = [
    {
      id: 'd',
      notes: [
        note(3, { position: { new_path: 'src/a.ts', new_line: 10 }, resolvable: true }),
        note(7, { resolvable: true, author: { username: 'bot', name: 'Bot', bot: true } }),
      ],
    },
    { id: 'e', notes: [note(4, { position: { old_path: 'src/b.ts', old_line: 3 } })] },
  ];
  gitlab({
    [`GET ${API}/merge_requests/12/discussions?per_page=100&page=1`]: {
      body: page1,
      headers: { 'x-next-page': '2' },
    },
    [`GET ${API}/merge_requests/12/discussions?per_page=100&page=2`]: {
      body: page2,
      headers: { 'x-next-page': '' },
    },
  });
  const comments = await host().pullRequestComments('shop/svc', 12, '2026-10-10T10:03:30.000Z');
  expect(comments).toEqual([
    {
      id: '4',
      author: 'Pessoa 4',
      authorId: 'p4',
      body: 'texto 4',
      createdAt: '2026-10-10T10:04:00.000Z',
      path: 'src/b.ts',
      line: 3,
      bot: false,
      reply: false,
    },
    {
      id: '5',
      author: 'Pessoa 5',
      authorId: 'p5',
      body: 'texto 5',
      createdAt: '2026-10-10T10:05:00.000Z',
      path: undefined,
      line: undefined,
      bot: false,
      reply: false,
    },
    {
      id: '7',
      author: 'Bot',
      authorId: 'bot',
      body: 'texto 7',
      createdAt: '2026-10-10T10:07:00.000Z',
      path: undefined,
      line: undefined,
      bot: true,
      reply: true,
    },
  ]);
});
test('a comment on the MR goes to its notes', async () => {
  const calls = gitlab({ [`POST ${API}/merge_requests/12/notes`]: { status: 201, body: {} } });
  await host().commentOnPullRequest('shop/svc', 12, 'feito');
  expect(calls[0].body).toEqual({ body: 'feito' });
});
test('branch date: the last commit, the branch name encoded (focus 1); missing branch is undefined', async () => {
  gitlab({
    [`GET ${API}/repository/branches/feature%2Fx`]: {
      body: { commit: { committed_date: '2026-10-09T12:00:00.000-03:00' } },
    },
  });
  expect(await host().branchDate('shop/svc', 'feature/x')).toBe('2026-10-09T12:00:00.000-03:00');
  expect(await host().branchDate('shop/svc', 'nope')).toBeUndefined();
});
test('network and server errors are retryable and mention the VPN; 403 is final, without the token (focus 5)', async () => {
  gitlab({ [`POST ${API}/merge_requests/1/notes`]: new TypeError('fetch failed') });
  await expect(host().commentOnPullRequest('shop/svc', 1, 'x')).rejects.toMatchObject({
    retryable: true,
    message: expect.stringMatching(/VPN/),
  });
  jest.restoreAllMocks();
  gitlab({ [`POST ${API}/merge_requests/1/notes`]: { status: 503 } });
  await expect(host().commentOnPullRequest('shop/svc', 1, 'x')).rejects.toMatchObject({
    retryable: true,
  });
  jest.restoreAllMocks();
  gitlab({ [`GET ${API}/repository/branches/b`]: { status: 403 } });
  const error = await host()
    .branchDate('shop/svc', 'b')
    .catch((e: TaskError) => e);
  expect(error).toBeInstanceOf(TaskError);
  expect((error as TaskError).retryable).toBe(false);
  expect((error as TaskError).message).not.toContain('glpat-secret');
  expect((error as TaskError).message).toContain('403');
});
test('clone over ssh, no HTTP header', () => {
  expect(host().cloneUrl('shop/svc')).toBe('ssh://git.example.com:2244/shop/svc.git');
  expect(host().gitAuthHeader()).toBe('');
});
test('merge request state, and comment authors carry their username', async () => {
  gitlab({
    [`GET ${API}/merge_requests/12`]: { body: { state: 'merged' } },
    [`GET ${API}/merge_requests/12/discussions?per_page=100&page=1`]: {
      body: [
        {
          id: 'a',
          notes: [
            {
              id: 1,
              body: '/ai x',
              created_at: '2026-10-10T10:00:00Z',
              author: { username: 'pat.doe', name: 'Pat' },
            },
          ],
        },
      ],
    },
  });
  expect(await host().mergeRequestState('shop/svc', 12)).toBe('merged');
  expect((await host().pullRequestComments('shop/svc', 12))[0]).toMatchObject({
    author: 'Pat',
    authorId: 'pat.doe',
  });
});

describe('git over ssh from the workspace (review of the first real run)', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTestsXXXXXXXXXXXXXXXXXXX';
  test('with the server key pinned: the Coder key, never a prompt, only that server key', () => {
    const h = new GitlabHost('gl', {
      baseUrl: 'https://git.example.com',
      sshUrl: 'ssh://git@git.example.com:2244',
      sshHostKey: KEY,
      token: 't',
    });
    expect(h.cloneUrl('shop/svc')).toBe('ssh://git@git.example.com:2244/shop/svc.git');
    expect(h.gitSshCommand()).toBe(
      `coder gitssh -- -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o 'KnownHostsCommand=/bin/echo [git.example.com]:2244 ${KEY}'`,
    );
  });
  test('the default port needs no brackets; without a pinned key it still never prompts', () => {
    const h = (sshHostKey?: string) =>
      new GitlabHost('gl', {
        baseUrl: 'https://git.example.com',
        sshUrl: 'ssh://git@git.example.com',
        sshHostKey,
        token: 't',
      });
    expect(h(KEY).gitSshCommand()).toContain(`/bin/echo git.example.com ${KEY}'`);
    expect(h().gitSshCommand()).toBe('coder gitssh -- -o BatchMode=yes');
  });
});
