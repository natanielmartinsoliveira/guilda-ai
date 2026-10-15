import { GithubHost } from '../src/hosts/github.host';
afterEach(() => jest.restoreAllMocks());
const input = { branch: 'ai/task-123', base: 'main', title: 'title', body: 'body' };
test('recovers already created PR before creating duplicate', async () => {
  const github = new GithubHost('gh', 'token');
  const request = jest
    .spyOn(github, 'request')
    .mockResolvedValue([{ id: 1, number: 2, html_url: 'https://github.com/example/demo/pull/2' }]);
  const pr = await github.ensurePullRequest('example/demo', input);
  expect(pr).toMatchObject({ id: '1', number: 2, url: 'https://github.com/example/demo/pull/2' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toContain(encodeURIComponent('example:ai/task-123'));
});
test('recovers ambiguous POST success through subsequent lookup', async () => {
  const github = new GithubHost('gh', 'token');
  jest
    .spyOn(github, 'request')
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('network lost'))
    .mockResolvedValueOnce([{ id: 1, number: 2 }]);
  expect((await github.ensurePullRequest('example/demo', input)).number).toBe(2);
});
test('clone URL and auth header are per repository and per token', () => {
  const github = new GithubHost('gh', 'secret-token');
  expect(github.cloneUrl('globex/site')).toBe('https://github.com/globex/site.git');
  expect(github.gitAuthHeader()).toBe(
    `Authorization: Basic ${Buffer.from('x-access-token:secret-token').toString('base64')}`,
  );
});
describe('GitHub PR comments', () => {
  test('conversation and line comments since a point in time, oldest first; review comments', async () => {
    const calls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      const u = String(url);
      const body = u.includes('/reviews/77/comments')
        ? [
            {
              id: 9,
              body: 'use enum',
              created_at: '2026-10-03T10:05:00Z',
              user: { login: 'ana', type: 'User' },
              path: 'a.ts',
              line: 3,
            },
          ]
        : u.includes('/issues/8/comments')
          ? [
              {
                id: 1,
                body: 'geral',
                created_at: '2026-10-03T10:02:00Z',
                user: { login: 'ana', type: 'User' },
              },
              {
                id: 2,
                body: 'ci',
                created_at: '2026-10-03T10:01:00Z',
                user: { login: 'bot', type: 'Bot' },
              },
            ]
          : [
              {
                id: 3,
                body: 'linha',
                created_at: '2026-10-03T10:03:00Z',
                user: { login: 'ze', type: 'User' },
                path: 'b.ts',
                original_line: 7,
                in_reply_to_id: 1,
              },
            ];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const host = new GithubHost('gh', 'tok');
    const list = await host.pullRequestComments('o/r', 8, '2026-10-03T10:00:00Z');
    expect(list.map((c) => [c.id, c.author, c.path, c.line, c.bot, c.reply])).toEqual([
      ['2', 'bot', undefined, undefined, true, false],
      ['1', 'ana', undefined, undefined, false, false],
      ['3', 'ze', 'b.ts', 7, false, true],
    ]);
    expect(calls.every((u) => u.includes('since=2026-10-03T10%3A00%3A00Z'))).toBe(true);
    expect((await host.reviewComments('o/r', 8, 77)).map((c) => [c.path, c.line, c.body])).toEqual([
      ['a.ts', 3, 'use enum'],
    ]);
  });
});
