import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_JS, RUN_SH } from '../src/evidence/kit';
import { commentText, EVIDENCE_DIR, evidencePrompt, readManifest } from '../src/evidence/evidence';

type Kit = {
  maskHeaders(h: Record<string, string>): Record<string, string>;
  stamp(d: Date): string;
  frameHtml(i: { url: string; at: string; image: string }): string;
  shot(page: unknown, title: string): Promise<void>;
  apiShot(page: unknown, call: Record<string, unknown>): Promise<void>;
};
let kit: Kit;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kit-'));
  await writeFile(join(dir, 'evidence-kit.cjs'), KIT_JS);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  kit = require(join(dir, 'evidence-kit.cjs'));
});
/** A Playwright page double: the framed print is "taken" by writing a file. */
function fakePage(url: string) {
  const opened: { html: string }[] = [];
  const page = {
    url: () => url,
    screenshot: jest.fn(async () => Buffer.from('raw')),
    context: () => ({
      newPage: async () => {
        const view = { html: '' };
        opened.push(view);
        return {
          setContent: async (html: string) => {
            view.html = html;
          },
          screenshot: async (o?: { path?: string }) => {
            if (o?.path) await writeFile(o.path, 'png');
            return Buffer.from('view');
          },
          close: async () => {},
        };
      },
    }),
  };
  return { page, opened };
}

test('masks credentials whatever the header case', () => {
  expect(
    kit.maskHeaders({
      Authorization: 'Bearer abc',
      'x-api-key': 'k',
      'X-CSRF-TOKEN': 't',
      cookie: 'c',
      Accept: 'application/json',
      'X-Tenant-Id': '1',
    }),
  ).toEqual({
    Authorization: '•••',
    'x-api-key': '•••',
    'X-CSRF-TOKEN': '•••',
    cookie: '•••',
    Accept: 'application/json',
    'X-Tenant-Id': '1',
  });
});

// The company in these tests prints in São Paulo time (formats.evidence.timezone).
beforeAll(() => {
  process.env.EVIDENCE_TZ = 'America/Sao_Paulo';
});
afterAll(() => {
  delete process.env.EVIDENCE_TZ;
});

test('stamp is São Paulo time with the zone', () => {
  expect(kit.stamp(new Date('2026-10-14T20:25:03Z'))).toBe(
    '14/10/2026 17:25:03 (America/Sao_Paulo)',
  );
});

test('the frame shows the real URL and the time, escaped', () => {
  const html = kit.frameHtml({
    url: 'http://localhost:3000/a?x=<b>',
    at: '14/10/2026 17:25:03 (America/Sao_Paulo)',
    image: 'data:image/png;base64,AA',
  });
  expect(html).toContain('http://localhost:3000/a?x=&lt;b&gt;');
  expect(html).toContain('14/10/2026 17:25:03 (America/Sao_Paulo)');
  expect(html).toContain('data:image/png;base64,AA');
});

describe('prints', () => {
  let out: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'ev-'));
    process.env.EVIDENCE_OUT = out;
  });
  afterEach(() => delete process.env.EVIDENCE_OUT);

  test('shot frames the page and records it in the manifest, numbered', async () => {
    const { page, opened } = fakePage('http://localhost:3000/contrato');
    await kit.shot(page, 'Tela de contrato');
    await kit.shot(page, 'Depois de salvar');
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.shots).toEqual([
      {
        file: '01-tela-de-contrato.png',
        title: 'Tela de contrato',
        url: 'http://localhost:3000/contrato',
        at: expect.stringMatching(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} \(America\/Sao_Paulo\)$/),
      },
      expect.objectContaining({ file: '02-depois-de-salvar.png' }),
    ]);
    expect(await readFile(join(out, '01-tela-de-contrato.png'), 'utf8')).toBe('png');
    expect(opened[0].html).toContain('http://localhost:3000/contrato');
  });

  test('apiShot lays out the call like Swagger with credentials masked', async () => {
    const { page, opened } = fakePage('about:blank');
    await kit.apiShot(page, {
      title: 'GET contrato',
      method: 'GET',
      url: 'http://localhost:3001/orders/1/contract',
      headers: { authorization: 'Bearer eyJsecret', 'X-Tenant-Id': '1' },
      status: 200,
      response: { items: [{ serviceDescription: 'Fibra' }] },
    });
    const view = opened[0].html;
    expect(view).toContain('curl -X');
    expect(view).toContain('http://localhost:3001/orders/1/contract');
    expect(view).toContain('serviceDescription');
    expect(view).not.toContain('eyJsecret');
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.shots[0]).toMatchObject({
      file: '01-get-contrato.png',
      url: 'http://localhost:3001/orders/1/contract',
    });
  });
});

test('run.sh runs the pinned Playwright image on the host network', () => {
  expect(RUN_SH).toContain('mcr.microsoft.com/playwright:v${version}-noble');
  expect(RUN_SH).toContain('--network host');
  expect(RUN_SH).toContain('-e TZ="$tz" -e EVIDENCE_TZ="$tz"');
  expect(RUN_SH).toContain('node /evidence/roteiro.cjs');
});

test('readManifest refuses empty lists, foreign files and missing fields', () => {
  const ok = { file: '01-a.png', title: 'a', url: 'http://l', at: 't' };
  expect(readManifest(JSON.stringify({ shots: [ok] }))).toEqual({ shots: [ok] });
  expect(readManifest('{"shots":[]}')).toEqual({ problem: expect.stringMatching(/nenhum print/) });
  for (const file of ['../x.png', '/etc/x.png', 'a.png', '01-a.svg'])
    expect(readManifest(JSON.stringify({ shots: [{ ...ok, file }] }))).toEqual({
      problem: expect.stringMatching(/arquivo/),
    });
  expect(readManifest(JSON.stringify({ shots: [{ ...ok, url: '' }] }))).toEqual({
    problem: expect.stringMatching(/URL/),
  });
  expect(readManifest(JSON.stringify({ shots: [{ ...ok, at: '' }] }))).toEqual({
    problem: expect.stringMatching(/data/),
  });
  expect(readManifest('nope')).toEqual({ problem: expect.stringMatching(/manifest/) });
});

test('without a company format, the comment is neutral', async () => {
  expect(
    await commentText([
      { file: '01-a.png', title: 'Tela', url: 'http://l/a', at: 'T1' },
      { file: '02-b.png', title: 'API', url: 'http://l/b', at: 'T2' },
    ]),
  ).toBe(
    'Evidência de teste (automática):\n\n1. Tela — http://l/a — T1\n[imagem 01-a.png]\n\n2. API — http://l/b — T2\n[imagem 02-b.png]',
  );
});

test('evidence only on routes that change code; the prompt names the kit and version', async () => {
  // Which routes have evidence is the method's call (routes.<r>.evidence).
  const prompt = await evidencePrompt({
    material: 'Mostrar o nome do plano',
    route: 'fact',
    notes: ['use a venda 1'],
    version: '1.48.2',
  });
  expect(prompt).toContain(`${EVIDENCE_DIR}/roteiro.cjs`);
  expect(prompt).toContain(`sh ${EVIDENCE_DIR}/run.sh`);
  expect(prompt).toContain('Playwright 1.48.2');
  expect(prompt).toContain('Mostrar o nome do plano');
  expect(prompt).toContain('- use a venda 1');
  expect(prompt).toContain('<resultado>concluido</resultado>');
});

test('the container runs as the workspace user and writes nothing but out/ in the kit folder', () => {
  expect(RUN_SH).toContain('--user "$(id -u):$(id -g)"');
  expect(RUN_SH).toContain('HOME=/tmp');
  expect(RUN_SH).toContain('cd /tmp');
  expect(RUN_SH).toContain('NODE_PATH=/tmp/node_modules node /evidence/roteiro.cjs');
  expect(RUN_SH).not.toContain(
    'npm init -y >/dev/null && npm i --no-save --no-audit --no-fund playwright@${version} >/dev/null && node roteiro.cjs',
  );
});
