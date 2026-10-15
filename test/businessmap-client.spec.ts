import { BusinessmapClient } from '../src/sources/businessmap/businessmap.client';
import { htmlToText, normalizeLabel, repositoryFromLink } from '../src/sources/businessmap/text';
import { BusinessmapSource } from '../src/tenants/tenants';

const source: BusinessmapSource = {
  id: 'businessmap',
  type: 'businessmap',
  baseUrl: 'https://bm.test',
  token: 'secret-key',
  boardId: 79,
  pollSeconds: 60,
  trigger: { columns: [3170], tag: 'AI-Dev-Team' },
  repositoryField: 13,
  routeTags: {},
};
function api(routes: Record<string, (q: URLSearchParams) => unknown>) {
  return jest.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = new URL(String(url));
    const body = routes[u.pathname]?.(u.searchParams);
    return new Response(JSON.stringify({ data: body ?? null }), {
      status: body === undefined ? 404 : 200,
    });
  });
}

test('htmlToText keeps paragraphs, lists and links, marks images', () => {
  expect(
    htmlToText(
      '<p>Problema:</p><ul><li>um</li><li>dois</li></ul><p>Veja <a href="https://x.test">aqui</a><img src="/i.png"></p><p>a&nbsp;&amp;&lt;b&gt;</p>',
    ),
  ).toBe('Problema:\n\n- um\n- dois\n\nVeja aqui (https://x.test) [imagem]\n\na &<b>');
  expect(htmlToText(undefined)).toBe('');
});

test('repositoryFromLink normalizes links to the company GitLab only', () => {
  const host = 'git.initech.example';
  for (const link of [
    'https://git.initech.example/shop/shop-orders',
    'https://Git.initech.example/shop/shop-orders.git',
    'http://git.initech.example/shop/shop-orders/',
    ' https://git.initech.example/shop/shop-orders/-/tree/main ',
  ])
    expect(repositoryFromLink(link, host)).toBe('shop/shop-orders');
  expect(repositoryFromLink('https://git.initech.example/shop/shop/front', host)).toBe(
    'shop/shop/front',
  );
  expect(repositoryFromLink('https://github.com/shop/x', host)).toBeUndefined();
  expect(repositoryFromLink('https://git.initech.example/shop', host)).toBeUndefined();
  expect(repositoryFromLink('não é link', host)).toBeUndefined();
});

test('normalizeLabel ignores case, accents and spaces around', () => {
  expect(normalizeLabel(' Correção ')).toBe('correcao');
});

test('candidates: trigger columns and tag, every page, each card once, open cards only, GET only', async () => {
  const http = api({
    '/api/v2/tags': () => [
      { tag_id: 7, label: 'ai-dev-team' },
      { tag_id: 8, label: 'regra' },
    ],
    '/api/v2/cards': (q) => {
      if (q.get('column_ids') === '3170')
        return q.get('page') === '2'
          ? { pagination: { all_pages: 2 }, data: [{ card_id: 2, section: 3 }] }
          : { pagination: { all_pages: 2 }, data: [{ card_id: 1, section: 3 }] };
      if (q.get('tag_ids') === '7')
        return {
          pagination: { all_pages: 1 },
          data: [
            { card_id: 2, section: 3 },
            { card_id: 3, section: 4 },
            { card_id: 5, section: 5 },
            { card_id: 4, section: 2 },
          ],
        };
    },
  });
  const client = new BusinessmapClient(source, http as unknown as typeof fetch);
  expect((await client.candidates()).map((c) => c.card_id)).toEqual([1, 2, 4]);
  for (const [url, init] of http.mock.calls) {
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).apikey).toBe('secret-key');
    const q = new URL(String(url)).searchParams;
    if (new URL(String(url)).pathname === '/api/v2/cards') expect(q.get('board_ids')).toBe('79');
  }
});

test('a trigger tag that does not exist yet finds nothing', async () => {
  const http = api({
    '/api/v2/tags': () => [],
    '/api/v2/cards': () => ({ pagination: { all_pages: 1 }, data: [] }),
  });
  const client = new BusinessmapClient(
    { ...source, trigger: { columns: [], tag: 'ai-dev-team' } },
    http as unknown as typeof fetch,
  );
  expect(await client.candidates()).toEqual([]);
  expect(http.mock.calls.some(([u]) => new URL(String(u)).pathname === '/api/v2/cards')).toBe(
    false,
  );
});

test('card reads one card; HTTP errors carry the status and never the key', async () => {
  const ok = api({ '/api/v2/cards/101': () => ({ card_id: 101, title: 'X' }) });
  expect((await new BusinessmapClient(source, ok as unknown as typeof fetch).card(101)).title).toBe(
    'X',
  );
  const denied = jest.fn(async () => new Response('nope', { status: 401 }));
  const error = await new BusinessmapClient(source, denied as unknown as typeof fetch)
    .card(1)
    .catch((e: Error) => e);
  expect(String(error)).toMatch(/HTTP 401/);
  expect(String(error)).not.toContain('secret-key');
  expect(() => new BusinessmapClient(source).card(-1)).toThrow(/card id/);
});
