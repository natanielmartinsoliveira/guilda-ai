import { BitbucketHost } from '../src/hosts/bitbucket.host';
import { GithubHost } from '../src/hosts/github.host';
afterEach(() => jest.restoreAllMocks());
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
test('Bitbucket: last commit date of a branch, undefined when it does not exist', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (url) =>
      String(url).includes('PF-24377')
        ? reply(200, { name: 'feature/PF-24377', target: { date: '2026-10-06T19:21:00+00:00' } })
        : reply(404, { error: { message: 'not found' } }),
    );
  const host = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
  expect(await host.branchDate('w/repo', 'feature/PF-24377')).toBe('2026-10-06T19:21:00+00:00');
  expect(await host.branchDate('w/repo', 'feature/PF-24378')).toBeUndefined();
  expect(String(fetch.mock.calls[0][0])).toBe(
    'https://api.bitbucket.org/2.0/repositories/w/repo/refs/branches/feature%2FPF-24377',
  );
});
test('GitHub: last commit date of a branch, undefined when it does not exist', async () => {
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (url) =>
      String(url).endsWith('/branches/main')
        ? reply(200, { commit: { commit: { committer: { date: '2026-10-07T10:00:00Z' } } } })
        : reply(404, { message: 'Branch not found' }),
    );
  const host = new GithubHost('gh', 'tok');
  expect(await host.branchDate('o/r', 'main')).toBe('2026-10-07T10:00:00Z');
  expect(await host.branchDate('o/r', 'feature/x')).toBeUndefined();
});
test('other errors are not "missing"', async () => {
  jest.spyOn(global, 'fetch').mockImplementation(async () => reply(500, {}));
  const host = new BitbucketHost('bb', { auth: 'access-token', token: 'tok' });
  await expect(host.branchDate('w/repo', 'x')).rejects.toThrow('returned 500');
});
