import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentText } from '../src/evidence/evidence';
import { kitDir } from '../src/evidence/evidence-store';
import { KIT_JS, RUN_SH } from '../src/evidence/kit';
import { DEFAULT_FORMATS } from '../src/formats/formats';

const SHOTS = [
  {
    file: '01-tela.png',
    title: 'Contrato com o nome do plano',
    url: 'http://localhost:3000/c',
    at: '14/10/2026 17:25:03 (America/Sao_Paulo)',
  },
  {
    file: '02-get-contrato.png',
    title: 'GET contrato',
    url: 'http://localhost:3001/orders/1/contract',
    at: '14/10/2026 17:25:09 (America/Sao_Paulo)',
  },
];
/** The comment format the operator's company uses today (it moves to its pack). */
const COMPANY_TEMPLATE =
  'Teste desenvolvedor:\nExecução: ( ) Manual   (x) Automática\nAmbiente: (x) Desenvolvimento   ( ) Homologação   ( ) Beta   ( ) Produção\n\n{{SHOTS}}';
let pack: string;
beforeEach(async () => {
  pack = await mkdtemp(join(tmpdir(), 'evidence-format-'));
});
afterEach(async () => {
  await rm(pack, { recursive: true, force: true });
});

test("with the company's template, the comment is the same text it was", async () => {
  await mkdir(join(pack, 'formats'), { recursive: true });
  await writeFile(join(pack, 'formats', 'evidence.md'), COMPANY_TEMPLATE);
  const evidence = { ...DEFAULT_FORMATS.evidence, comment: 'formats/evidence.md' };
  expect(await commentText(SHOTS, evidence, pack)).toBe(
    await readFile(join(__dirname, 'fixtures', 'golden', 'evidence-comment.txt'), 'utf8'),
  );
});

test('the core comment is neutral', async () => {
  const text = await commentText(SHOTS, DEFAULT_FORMATS.evidence);
  expect(
    text.startsWith('Evidência de teste (automática):\n\n1. Contrato com o nome do plano'),
  ).toBe(true);
  expect(text).not.toContain('Teste desenvolvedor');
});

test('a comment template outside the pack is refused', async () => {
  const evidence = { ...DEFAULT_FORMATS.evidence, comment: '../../etc/passwd' };
  await expect(commentText(SHOTS, evidence, pack)).rejects.toThrow(/pacote/);
});

describe('time zone of the prints', () => {
  let kit: { stamp(d: Date): string };
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kit-tz-'));
    await writeFile(join(dir, 'k.cjs'), KIT_JS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    kit = require(join(dir, 'k.cjs'));
  });
  afterEach(() => delete process.env.EVIDENCE_TZ);
  test('the configured zone, named in the stamp', () => {
    process.env.EVIDENCE_TZ = 'America/Sao_Paulo';
    expect(kit.stamp(new Date('2026-10-14T20:25:03Z'))).toBe(
      '14/10/2026 17:25:03 (America/Sao_Paulo)',
    );
  });
  test('UTC when none is configured', () => {
    expect(kit.stamp(new Date('2026-10-14T20:25:03Z'))).toBe('14/10/2026 20:25:03 (UTC)');
  });
  test('the kit folder carries the zone and run.sh passes it to the container', async () => {
    const dir = await kitDir('1.48.2', 'America/Sao_Paulo');
    expect(await readFile(join(dir, 'timezone'), 'utf8')).toBe('America/Sao_Paulo');
    expect(RUN_SH).toContain('tz=$(cat "$here/timezone"');
    expect(RUN_SH).toContain('-e TZ="$tz" -e EVIDENCE_TZ="$tz"');
    expect(RUN_SH).not.toContain('America/Sao_Paulo');
    await rm(dir, { recursive: true, force: true });
  });
});
