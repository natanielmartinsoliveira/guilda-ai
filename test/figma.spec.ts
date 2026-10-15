import { TaskError } from '../src/config';
import {
  FigmaClient,
  FigmaError,
  figmaLinks,
  FigmaNode,
  indexMarkdown,
  rankScreens,
  screensOf,
  textsOf,
} from '../src/design/figma';
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const text = (id: string, characters: string, y = 0): FigmaNode => ({
  id,
  name: characters,
  type: 'TEXT',
  characters,
  absoluteBoundingBox: box(0, y, 100, 20),
});
const screen = (id: string, name: string, x: number, texts: string[]): FigmaNode => ({
  id,
  name,
  type: 'FRAME',
  absoluteBoundingBox: box(x, 0, 1440, 1024),
  children: texts.map((t, i) => text(`${id}-t${i}`, t, i * 30)),
});
describe('links', () => {
  test('design/file links with node-id, deduplicated; markdown links too', () => {
    const body =
      'Layout: https://www.figma.com/design/fop55NNm7iKgLYWWmvwMoR/Recusa?node-id=2143-47824&t=x e [aqui](https://www.figma.com/design/fop55NNm7iKgLYWWmvwMoR/Recusa?node-id=2143-47824) e https://figma.com/file/AbCdEfGhIjKl/Outro';
    expect(figmaLinks(body).map((l) => [l.key, l.node])).toEqual([
      ['fop55NNm7iKgLYWWmvwMoR', '2143:47824'],
      ['AbCdEfGhIjKl', undefined],
    ]);
    expect(
      figmaLinks('node-id=1%3A2 https://www.figma.com/design/AbCdEfGhIjKl/x?node-id=1%3A2')[0].node,
    ).toBe('1:2');
    expect(figmaLinks('sem link')).toEqual([]);
  });
});
describe('screens and texts', () => {
  test('a frame holding screens gives its screen-sized frames; notes are left out', () => {
    const board: FigmaNode = {
      id: '1:1',
      name: 'proposta',
      type: 'FRAME',
      absoluteBoundingBox: box(0, 0, 13096, 4728),
      children: [
        screen('2:1', 'Tela principal', 0, ['Indique seus avaliadores']),
        { id: '2:2', name: 'nota', type: 'FRAME', absoluteBoundingBox: box(0, 0, 200, 80) },
        {
          id: '2:3',
          name: 'grupo',
          type: 'SECTION',
          absoluteBoundingBox: box(2000, 0, 3000, 1100),
          children: [screen('3:1', 'Modal recusa', 2000, ['Reprovar indicação?', 'Cancelar'])],
        },
      ],
    };
    expect(screensOf(board).map((s) => s.name)).toEqual(['Tela principal', 'Modal recusa']);
  });
  test('a link to one screen is that screen (its inner layout frames are not screens)', () => {
    const one: FigmaNode = {
      ...screen('5:1', 'Detalhe', 0, []),
      children: [
        { id: '5:2', name: 'header', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1440, 64) },
        { id: '5:3', name: 'conteúdo', type: 'FRAME', absoluteBoundingBox: box(0, 64, 1200, 900) },
      ],
    };
    expect(screensOf(one).map((s) => s.id)).toEqual(['5:1']);
  });
  test('texts in reading order (top to bottom), without repeats or hidden ones', () => {
    const node: FigmaNode = {
      id: 'a',
      name: 'a',
      type: 'FRAME',
      children: [
        text('t2', 'Segundo', 50),
        text('t1', 'Primeiro', 10),
        text('t3', 'Primeiro', 90),
        { ...text('t4', 'Oculto', 5), visible: false },
      ],
    };
    expect(textsOf(node)).toEqual(['Primeiro', 'Segundo']);
  });
  test('texts made only of invisible characters are left out (seen in the real file)', () => {
    const node: FigmaNode = {
      id: 'a',
      name: 'a',
      type: 'FRAME',
      children: [text('t1', '​', 1), text('t2', '﻿ ‍', 2), text('t3', 'Pares', 3)],
    };
    expect(textsOf(node)).toEqual(['Pares']);
  });
  test('screens sharing words with the task come first', () => {
    const ranked = rankScreens(
      [
        { name: 'Home', texts: ['Bem-vindo'] },
        { name: 'Modal', texts: ['Reprovar indicação?'] },
        { name: 'Lista', texts: ['Avaliadores indicados'] },
      ],
      'Botão Reprovar com modal de dupla confirmação na lista de avaliadores',
      2,
    );
    expect(ranked.map((s) => s.name)).toEqual(['Modal', 'Lista']);
  });
  test('the index lists every screen, marks the attached ones and says what was cut', () => {
    const md = indexMarkdown({
      url: 'https://figma.com/design/k/x?node-id=1-1',
      title: 'Recusa da indicação',
      screens: [
        {
          id: '1',
          name: 'Modal',
          width: 1440,
          height: 1024,
          texts: ['Reprovar?'],
          file: 'figma/01-modal.png',
        },
        {
          id: '2',
          name: 'Lista',
          width: 1440,
          height: 1024,
          texts: [],
          file: 'figma/02-lista.png',
        },
      ],
      attached: new Set(['1']),
      cut: 3,
    });
    expect(md).toContain('# Design do Figma: Recusa da indicação');
    expect(md).toContain('## ★ 01 — Modal (1440×1024) — figma/01-modal.png');
    expect(md).toContain('- Reprovar?');
    expect(md).toContain('## 02 — Lista (1440×1024) — figma/02-lista.png');
    expect(md).toContain('Mais 3 telas');
  });
});
describe('client', () => {
  const reply = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  test('reads a node with the token header and the file version', async () => {
    const fetch = jest.fn(async () =>
      reply(200, {
        name: 'Arquivo',
        version: '42',
        nodes: { '1:2': { document: screen('1:2', 'Tela', 0, []) } },
      }),
    );
    const out = await new FigmaClient('figd_x', fetch as any).node('KEY', '1:2');
    expect(out.version).toBe('42');
    expect(out.document.name).toBe('Tela');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.figma.com/v1/files/KEY/nodes?ids=1%3A2');
    expect(new Headers(init.headers).get('X-Figma-Token')).toBe('figd_x');
  });
  test('403/404 are access errors; 429/5xx and network failures are retried later', async () => {
    const at = (status: number) => new FigmaClient('t', (async () => reply(status, {})) as any);
    await expect(at(403).node('K', '1:2')).rejects.toBeInstanceOf(FigmaError);
    await expect(at(404).node('K', '1:2')).rejects.toMatchObject({ status: 404 });
    const busy = await at(429)
      .node('K', '1:2')
      .catch((e) => e);
    expect(busy).toBeInstanceOf(TaskError);
    expect(busy.retryable).toBe(true);
    const down = new FigmaClient('t', (async () => {
      throw new TypeError('fetch failed');
    }) as any);
    await expect(down.node('K', '1:2')).rejects.toMatchObject({ retryable: true });
  });
  test('images by id, with the scale; download without the token', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(reply(200, { err: null, images: { '1:2': 'https://s3/img.png' } }))
      .mockResolvedValueOnce(new Response(Buffer.from('PNG'), { status: 200 }));
    const client = new FigmaClient('t', fetch as any);
    expect(await client.images('K', ['1:2'], 0.5)).toEqual({ '1:2': 'https://s3/img.png' });
    expect(fetch.mock.calls[0][0]).toBe(
      'https://api.figma.com/v1/images/K?ids=1%3A2&format=png&scale=0.5',
    );
    expect((await client.download('https://s3/img.png')).toString()).toBe('PNG');
    expect(new Headers((fetch.mock.calls[1][1] ?? {}).headers).get('X-Figma-Token')).toBeNull();
  });
});
test('a linked screen with a modal over the page stays one screen (review I6)', () => {
  const modal: FigmaNode = {
    id: '9:1',
    name: 'Tela com modal',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 1024 },
    children: [
      {
        id: '9:2',
        name: 'página',
        type: 'INSTANCE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 1024 },
      },
      {
        id: '9:3',
        name: 'modal',
        type: 'FRAME',
        absoluteBoundingBox: { x: 420, y: 300, width: 600, height: 400 },
      },
    ],
  };
  expect(screensOf(modal).map((s) => s.id)).toEqual(['9:1']);
});
test('a render timeout on images (400 with err) is retried later, not "not found" (review M2)', async () => {
  const client = new FigmaClient(
    't',
    (async () => new Response(JSON.stringify({ err: 'Render timeout' }), { status: 400 })) as any,
  );
  const error = await client.images('K', ['1:2'], 1).catch((e) => e);
  expect(error).toBeInstanceOf(TaskError);
  expect(error.retryable).toBe(true);
});
