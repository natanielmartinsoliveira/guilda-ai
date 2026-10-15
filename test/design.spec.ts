import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DesignService,
  FIX_ACCESS,
  NO_ACCESS,
  NO_DESIGN,
  NO_DESIGN_OPTIONS,
  ONLY_IMAGES,
  WHOLE_FILE,
} from '../src/design/design.service';
import { NeedsInput } from '../src/tasks/decisions';
import type { Tenant } from '../src/tenants/tenants';
import type { Clarification } from '../src/database/entities';
const tenant = { id: 'acme', figma: { token: 'figd_tok' } } as unknown as Tenant;
const LINK = 'https://www.figma.com/design/AbCdEfGhIjKl/Recusa?node-id=1-2';
const frame = (id: string, name: string, x: number, texts: string[]) => ({
  id,
  name,
  type: 'FRAME',
  absoluteBoundingBox: { x, y: 0, width: 1440, height: 1024 },
  children: texts.map((t, i) => ({
    id: `${id}t${i}`,
    name: t,
    type: 'TEXT',
    characters: t,
    absoluteBoundingBox: { x, y: i * 10, width: 100, height: 10 },
  })),
});
const board = {
  id: '1:2',
  name: 'proposta',
  type: 'SECTION',
  absoluteBoundingBox: { x: 0, y: 0, width: 9000, height: 2000 },
  children: Array.from({ length: 10 }, (_, i) =>
    frame(
      `2:${i}`,
      i === 7 ? 'Modal reprovar' : `Tela ${i}`,
      i * 1500,
      i === 7 ? ['Reprovar indicação?'] : ['Outro'],
    ),
  ),
};
function figma(version = '7') {
  return jest.fn(async (url: string) => {
    if (url.includes('/nodes?'))
      return new Response(
        JSON.stringify({ name: 'Recusa', version, nodes: { '1:2': { document: board } } }),
      );
    if (url.includes('/images/')) {
      const ids = decodeURIComponent(/ids=([^&]+)/.exec(url)![1]).split(',');
      return new Response(
        JSON.stringify({
          err: null,
          images: Object.fromEntries(ids.map((id) => [id, `https://cdn/${id}.png`])),
        }),
      );
    }
    return new Response(Buffer.from(`PNG ${url}`));
  });
}
let root: string, dir: string;
const answered = (question: string, text: string): Clarification => ({
  kind: 'answer',
  question,
  text,
  at: '2026-10-07T10:00:00Z',
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'design-'));
  // The download cache lives under the test ATTACHMENTS_ROOT (config is read once).
  dir = join(root, 'acme', 'jira', '123');
});
afterEach(() => rm(root, { recursive: true, force: true }));
const service = (fetch: jest.Mock = figma()) => {
  const s = new DesignService();
  s.fetchImpl = fetch as any;
  return s;
};
const input = (over: object = {}) => ({
  tenant,
  texts: [`Card com layout: ${LINK}`],
  about: 'Botão Reprovar com modal',
  clarifications: [],
  images: 0,
  dir,
  ...over,
});
test('a frame link: index of every screen, the related ones attached as images', async () => {
  const out = await service().prepare(input());
  expect(out.source).toBe('figma');
  expect(out.files[0]).toMatchObject({ name: 'figma/index.md', contentType: 'text/markdown' });
  const images = out.files.slice(1);
  expect(images).toHaveLength(8);
  expect(images[0].name).toBe('figma/08-modal-reprovar.png');
  expect((await readdir(join(dir, 'figma'))).filter((f) => f.endsWith('.png'))).toHaveLength(10);
  const index = await readFile(join(dir, 'figma', 'index.md'), 'utf8');
  expect(index).toContain('★ 08 — Modal reprovar');
  expect(index).toContain('- Reprovar indicação?');
});
test('the second sub-task of a story reuses the downloaded design (same version)', async () => {
  const fetch = figma();
  await service(fetch).prepare(input());
  const calls = fetch.mock.calls.length;
  await service(fetch).prepare(input({ dir: join(root, 'acme', 'jira', '456') }));
  // Only the node read (to learn the version) happens again.
  expect(fetch.mock.calls.length - calls).toBe(1);
});
test('no link and no images: asks before any AI (focus 2: "I will send it" without a link asks again)', async () => {
  const ask = (clarifications: Clarification[]) =>
    service()
      .prepare(input({ texts: ['sem design'], clarifications }))
      .catch((e) => e);
  const first = await ask([]);
  expect(first).toBeInstanceOf(NeedsInput);
  expect(first.questions).toEqual([{ text: NO_DESIGN, options: NO_DESIGN_OPTIONS }]);
  expect(await ask([answered(NO_DESIGN, NO_DESIGN_OPTIONS[1])])).toBeInstanceOf(NeedsInput);
  const go = await ask([answered(NO_DESIGN, NO_DESIGN_OPTIONS[0])]);
  expect(go).toMatchObject({ source: 'none', files: [] });
  expect(go.note).toMatch(/padrão/);
});
test('a link pasted in the answer is used', async () => {
  const out = await service().prepare(
    input({ texts: ['sem design', `Resposta do operador: ${LINK}`] }),
  );
  expect(out.source).toBe('figma');
});
test('prints only: go with the images', async () => {
  expect(await service().prepare(input({ texts: ['sem link'], images: 3 }))).toMatchObject({
    source: 'images',
    files: [],
  });
});
test('a link to the whole file asks for the frame, even with prints (focus 3)', async () => {
  const out = await service()
    .prepare(input({ texts: ['https://www.figma.com/design/AbCdEfGhIjKl/Recusa'], images: 3 }))
    .catch((e) => e);
  expect(out).toBeInstanceOf(NeedsInput);
  expect(out.questions[0].text).toBe(WHOLE_FILE);
});
test('no access: asks; "go with the images" is honoured when there are images', async () => {
  const denied = service(jest.fn(async () => new Response('{}', { status: 403 })));
  const asked = await denied.prepare(input({ images: 2 })).catch((e) => e);
  expect(asked).toBeInstanceOf(NeedsInput);
  expect(asked.questions[0].text.startsWith(NO_ACCESS)).toBe(true);
  expect(asked.questions[0].options).toEqual([ONLY_IMAGES, FIX_ACCESS]);
  const go = await denied.prepare(
    input({ images: 2, clarifications: [answered(asked.questions[0].text, ONLY_IMAGES)] }),
  );
  expect(go.source).toBe('images');
  const none = await service(jest.fn(async () => new Response('{}', { status: 404 })))
    .prepare(input())
    .catch((e) => e);
  expect(none.questions[0].options).toEqual([FIX_ACCESS]);
});
test('no token configured counts as no access, without calling Figma', async () => {
  const fetch = figma();
  const out = await service(fetch)
    .prepare(input({ tenant: { id: 'acme' } as unknown as Tenant }))
    .catch((e) => e);
  expect(out).toBeInstanceOf(NeedsInput);
  expect(fetch).not.toHaveBeenCalled();
});
test('a link pasted in an answer wins over the one in the card (review I3)', async () => {
  // The card points at a frame the token cannot read; the operator answers with another one.
  const out = await service().prepare(
    input({
      texts: ['https://www.figma.com/design/AbCdEfGhIjKl/Recusa?node-id=5-5'],
      clarifications: [
        answered(`${NO_ACCESS} (arquivo ou frame não encontrado). Como seguir?`, LINK),
      ],
    }),
  );
  expect(out.source).toBe('figma');
});
test('the whole-file question offers a way out (review I5)', async () => {
  const whole = 'https://www.figma.com/design/AbCdEfGhIjKl/Recusa';
  const asked = await service()
    .prepare(input({ texts: [whole], images: 2 }))
    .catch((e) => e);
  expect(asked.questions[0].options).toEqual([ONLY_IMAGES, NO_DESIGN_OPTIONS[0]]);
  const images = await service().prepare(
    input({ texts: [whole], images: 2, clarifications: [answered(WHOLE_FILE, ONLY_IMAGES)] }),
  );
  expect(images.source).toBe('images');
  const pattern = await service().prepare(
    input({ texts: [whole], clarifications: [answered(WHOLE_FILE, NO_DESIGN_OPTIONS[0])] }),
  );
  expect(pattern.source).toBe('none');
});
test('screens are rendered in small batches (review M2: render timeouts)', async () => {
  const many = {
    ...board,
    children: Array.from({ length: 25 }, (_, i) => frame(`4:${i}`, `Tela ${i}`, i * 1500, ['x'])),
  };
  const fetch = jest.fn(async (url: string) => {
    if (url.includes('/nodes?'))
      return new Response(
        JSON.stringify({
          name: 'R',
          version: `batch${Date.now()}`,
          nodes: { '1:2': { document: many } },
        }),
      );
    if (url.includes('/images/')) {
      const ids = decodeURIComponent(/ids=([^&]+)/.exec(url)![1]).split(',');
      return new Response(
        JSON.stringify({
          err: null,
          images: Object.fromEntries(ids.map((id) => [id, `https://cdn/${id}.png`])),
        }),
      );
    }
    return new Response(Buffer.from('PNG'));
  });
  await service(fetch).prepare(input());
  const batches = fetch.mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.includes('/images/'))
    .map((u) => decodeURIComponent(/ids=([^&]+)/.exec(u)![1]).split(',').length);
  expect(batches).toEqual([10, 10, 5]);
});
