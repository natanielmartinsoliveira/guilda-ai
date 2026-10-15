import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { answersIo, runSetup, setEnvValues, SetupIo } from '../src/setup/setup';

const ACME = resolve(__dirname, '..', 'examples', 'packs', 'acme');
const SECRETS = {
  ACME_GITHUB_TOKEN: 'github_pat_secret_0123456789',
  ACME_GITHUB_WEBHOOK_SECRET: 'whsec-0123456789abcdef',
  ACME_OPENAI_API_KEY: 'sk-secret-value-xyz',
};
let dir: string;
let lang: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-'));
  lang = process.env.GUILDA_LANG;
});
afterEach(async () => {
  if (lang === undefined) delete process.env.GUILDA_LANG;
  else process.env.GUILDA_LANG = lang;
  await rm(dir, { recursive: true, force: true });
});

/** The example pack as a company's git repository, with a baseline script. */
async function packRepo(setupYaml?: string) {
  const repo = join(dir, 'remote', 'acme');
  await cp(ACME, repo, { recursive: true });
  if (setupYaml) {
    await writeFile(join(repo, 'setup.yaml'), setupYaml);
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await writeFile(join(repo, 'scripts', 'hello.sh'), 'echo hello\n');
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'pack');
  return `file://${repo}`;
}
/** Records what was asked (and how) on top of the answers. */
function recording(answers: Record<string, string | boolean>) {
  const said: string[] = [];
  const io = answersIo(answers, said);
  const asked: { key: string; secret: boolean }[] = [];
  const wrapped: SetupIo = {
    ask: (key, question, opts) => {
      asked.push({ key, secret: !!opts?.secret });
      said.push(question);
      return io.ask(key, question, opts);
    },
    confirm: (key, question) => {
      said.push(question);
      return io.confirm(key, question);
    },
    say: io.say,
  };
  return { io: wrapped, said, asked };
}

test('non-interactive: clones the pack, keeps the existing .env, writes only what was asked, loads the company', async () => {
  const url = await packRepo();
  const root = join(dir, 'instance');
  await mkdir(root);
  await writeFile(join(root, '.env'), 'PORT=3000\n# keep me\nACME_GIT_NAME=Pat Doe (AI)\n');
  const x = recording({
    language: 'en',
    packs: url,
    ACME_GIT_EMAIL: 'pat@acme.example',
    ...SECRETS,
  });
  const result = await runSetup({ root, packsRoot: join(dir, 'packs'), io: x.io, run: jest.fn() });
  expect(result.ok).toBe(true);
  expect(result.tenants).toEqual([expect.objectContaining({ id: 'acme' })]);
  const env = await readFile(join(root, '.env'), 'utf8');
  expect(env.startsWith('PORT=3000\n# keep me\nACME_GIT_NAME=Pat Doe (AI)\n')).toBe(true);
  expect(env).toContain('GUILDA_LANG=en\n');
  expect(env).toContain(`GUILDA_PACKS=${join(dir, 'packs', 'acme')}\n`);
  expect(env).toContain('ACME_GIT_EMAIL=pat@acme.example\n');
  expect(env).toContain(`ACME_GITHUB_TOKEN=${SECRETS.ACME_GITHUB_TOKEN}\n`);
  // A value already in .env is never asked again; secrets are asked without echo.
  expect(x.asked.map((a) => a.key)).not.toContain('ACME_GIT_NAME');
  expect(x.asked.find((a) => a.key === 'ACME_GITHUB_TOKEN')!.secret).toBe(true);
  expect(x.asked.find((a) => a.key === 'ACME_GIT_EMAIL')!.secret).toBe(false);
  // The file holds secrets: only its owner reads it.
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  // Nothing the wizard prints carries a secret (Review Focus 2).
  const printed = x.said.join('\n');
  for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
});

test('running it again asks nothing already answered and changes nothing', async () => {
  const url = await packRepo();
  const root = join(dir, 'instance');
  await mkdir(root);
  const answers = {
    language: 'pt-BR',
    packs: url,
    ACME_GIT_NAME: 'Pat',
    ACME_GIT_EMAIL: 'p@acme.example',
    ...SECRETS,
  };
  await runSetup({
    root,
    packsRoot: join(dir, 'packs'),
    io: answersIo(answers, []),
    run: jest.fn(),
  });
  const first = await readFile(join(root, '.env'), 'utf8');
  const again = recording({ language: 'pt-BR', packs: url });
  const result = await runSetup({
    root,
    packsRoot: join(dir, 'packs'),
    io: again.io,
    run: jest.fn(),
  });
  expect(result.ok).toBe(true);
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(first);
  expect(again.asked.map((a) => a.key)).toEqual(['language', 'packs']);
});

test('baseline scripts run only when confirmed; a script outside the pack is refused', async () => {
  const url = await packRepo(`scripts:
  - { run: scripts/hello.sh, description: Says hello }
  - { run: ../evil.sh, description: Escapes }
  - { run: scripts/hello.sh, description: Listed twice }
`);
  const root = join(dir, 'instance');
  await mkdir(root);
  const run = jest.fn();
  const said: string[] = [];
  const confirms: string[] = [];
  const io = answersIo(
    {
      language: 'en',
      packs: url,
      ACME_GIT_NAME: 'Pat',
      ACME_GIT_EMAIL: 'p@acme.example',
      ...SECRETS,
      'run:acme/scripts/hello.sh': true,
    },
    said,
  );
  await runSetup({
    root,
    packsRoot: join(dir, 'packs'),
    io: { ...io, confirm: (key, q) => (confirms.push(key), io.confirm(key, q)) },
    run,
  });
  const pack = join(dir, 'packs', 'acme');
  expect(run.mock.calls).toEqual([
    [join(pack, 'scripts', 'hello.sh'), pack],
    [join(pack, 'scripts', 'hello.sh'), pack],
  ]);
  expect(confirms).not.toContain('run:acme/../evil.sh');
  expect(said.join('\n')).toMatch(/\.\.\/evil\.sh/);
});

test('without the confirmation no baseline script runs', async () => {
  const url = await packRepo('scripts:\n  - { run: scripts/hello.sh, description: Says hello }\n');
  const root = join(dir, 'instance');
  await mkdir(root);
  const run = jest.fn();
  await runSetup({
    root,
    packsRoot: join(dir, 'packs'),
    io: answersIo(
      {
        language: 'en',
        packs: url,
        ACME_GIT_NAME: 'Pat',
        ACME_GIT_EMAIL: 'p@acme.example',
        ...SECRETS,
      },
      [],
    ),
    run,
  });
  expect(run).not.toHaveBeenCalled();
});

test('a missing value is reported by the load test, never invented', async () => {
  const url = await packRepo();
  const root = join(dir, 'instance');
  await mkdir(root);
  const said: string[] = [];
  const result = await runSetup({
    root,
    packsRoot: join(dir, 'packs'),
    io: answersIo({ language: 'en', packs: url }, said),
    run: jest.fn(),
  });
  expect(result.ok).toBe(false);
  expect(said.join('\n')).toMatch(/ACME_GITHUB_TOKEN/);
  expect(await readFile(join(root, '.env'), 'utf8')).not.toMatch(/ACME_GITHUB_TOKEN=/);
});

test('an invalid language is refused', async () => {
  await expect(
    runSetup({
      root: dir,
      packsRoot: join(dir, 'packs'),
      io: answersIo({ language: 'fr' }, []),
      run: jest.fn(),
    }),
  ).rejects.toThrow(/fr/);
});

test('setEnvValues replaces only the given keys, appends new ones and quotes what needs it', () => {
  const before = '# comment\nA=1\nB=old\n';
  expect(setEnvValues(before, { B: 'new', C: 'two words', D: "it's #1" })).toBe(
    "# comment\nA=1\nB=new\nC='two words'\nD=`it's #1`\n",
  );
  expect(setEnvValues('A=1', { A: '2' })).toBe('A=2\n');
  expect(() => setEnvValues('', { A: 'x\ny' })).toThrow(/A/);
});

test('every value reads back exactly as typed, or is refused (review I5)', () => {
  for (const value of [
    `p'a"ss`,
    `it's\\x`,
    `x'y\\nz`,
    'a b',
    'a#b',
    '$HOME',
    'back\\slash',
    'q"uote',
    'tick`s',
  ])
    expect(parseEnv(setEnvValues('', { K: value })).K).toBe(value);
  expect(() => setEnvValues('', { K: `all'three"\`` })).toThrow(/K/);
});

test('a pack URL with credentials never shows them, even when the clone fails (review I4)', async () => {
  const root = join(dir, 'instance');
  await mkdir(root);
  const said: string[] = [];
  let message = '';
  try {
    await runSetup({
      root,
      packsRoot: join(dir, 'packs'),
      io: answersIo(
        { language: 'en', packs: 'https://pat:S3cretT0ken@127.0.0.1:9/acme.git' },
        said,
      ),
      run: jest.fn(),
    });
  } catch (error) {
    message = String(error);
  }
  expect(message).toMatch(/127\.0\.0\.1/);
  expect(`${message}\n${said.join('\n')}`).not.toContain('S3cretT0ken');
});
