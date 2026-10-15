import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forbiddenTerms, formatFinding, scanTree } from '../src/public/public-check';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'public-check-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pack() {
  const p = join(dir, 'packs', 'globex');
  await mkdir(p, { recursive: true });
  await writeFile(
    join(p, 'company.yaml'),
    `id: globex
name: Globex Corporation
git: { authorName: Hank Scorpio (AI), authorEmail: hank@globex.test }
hosts:
  - { id: gl, type: gitlab, baseUrl: https://git.globex.internal, token: "\${GLOBEX_GITLAB_TOKEN}" }
projects:
  - id: payments-core
    host: gl
    repository: gx/payments-core
    workspace: { type: coder, url: https://coder.globex.internal, name: hank-ws, reference: /workspaces/payments-core }
  - id: front
    repository: gx/front
`,
  );
  return p;
}

test('the terms come from the packs, tenants.yaml, the .env (never its secrets) and .public-deny', async () => {
  const terms = forbiddenTerms({
    packDirs: [await pack()],
    yamlFiles: [],
    env: {
      GLOBEX_GIT_NAME: 'Hank Scorpio',
      GLOBEX_CODER_WORKSPACE: 'hank-ws-2',
      GLOBEX_GITLAB_TOKEN: 'fake-gitlab-token-value',
      WEB_PASSWORD_HASH: 'scrypt$aa$bb',
      NODE_ENV: 'production',
      PORT: '3000',
      GUILDA_LANG: 'pt-BR',
      WORKSPACE_ROOT: '/home/hank/work',
      ATTACHMENTS_ROOT: '/home/hank/ai-dev-team/attachments',
      TENANTS_FILE: 'tenants.yaml',
      DATABASE_NAME: 'ai_dev_team',
    },
    deny: ['Project Arcturus'],
  });
  for (const t of [
    'globex',
    'globex corporation',
    'git.globex.internal',
    'coder.globex.internal',
    'hank@globex.test',
    'payments-core',
    'gx/payments-core',
    'hank-ws',
    'hank-ws-2',
    'hank',
    'scorpio',
    'project arcturus',
  ])
    expect(terms).toContain(t);
  for (const t of [
    'fake-gitlab-token-value',
    'scrypt$aa$bb',
    'production',
    '3000',
    'pt-br',
    'front',
    'home',
    'work',
    'ai',
    'attachments',
    'tenants.yaml',
    'ai_dev_team',
  ])
    expect(terms).not.toContain(t);
});

async function repo(files: Record<string, string | Buffer>) {
  const r = join(dir, 'repo');
  await mkdir(r);
  execFileSync('git', ['init', '-q'], { cwd: r });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(r, name, '..'), { recursive: true });
    await writeFile(join(r, name), body);
  }
  execFileSync('git', ['add', '-A'], { cwd: r });
  return r;
}

test('a term in a versioned or new file is found with its file and line, never printed whole (Review Focus 1)', async () => {
  const r = await repo({
    'src/a.ts': 'const x = 1;\n// see the Globex board\n',
    'README.md': 'ok\n',
  });
  await writeFile(join(r, 'notes.md'), 'one\ntwo\nmail hank@globex.test\n');
  const found = scanTree(r, ['globex', 'hank@globex.test']);
  expect(found).toEqual([
    { file: 'notes.md', line: 3, term: 'hank@globex.test' },
    { file: 'notes.md', line: 3, term: 'globex' },
    { file: 'src/a.ts', line: 2, term: 'globex' },
  ]);
  const printed = found.map(formatFinding).join('\n');
  expect(printed).toContain('src/a.ts:2');
  expect(printed).not.toMatch(/globex/i);
  expect(printed).not.toContain('hank@');
  expect(formatFinding(found[2])).toBe('src/a.ts:2  gl… (6 letras)');
});

test('a short term counts only as a whole word; ignored and binary files are not read', async () => {
  const r = await repo({
    'a.md': 'the acmeville road\n',
    'b.md': 'by Acme.\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x61, 0x63, 0x6d, 0x65]),
    '.gitignore': 'secret.txt\n',
  });
  await writeFile(join(r, 'secret.txt'), 'acme\n');
  expect(scanTree(r, ['acme'])).toEqual([{ file: 'b.md', line: 1, term: 'acme' }]);
});

test('a clean tree passes', async () => {
  const r = await repo({ 'a.md': 'Initech and Acme are fictitious.\n' });
  expect(scanTree(r, ['globex', 'hank'])).toEqual([]);
});

describe('review fixes', () => {
  test('ids in .env (a chat id) are terms; secrets still are not (C1)', () => {
    const terms = forbiddenTerms({
      packDirs: [],
      yamlFiles: [],
      env: { TELEGRAM_CHAT_ID: '8123456789', TELEGRAM_BOT_TOKEN: '999:secret-token' },
      deny: [],
    });
    expect(terms).toContain('8123456789');
    expect(terms.join(' ')).not.toContain('secret-token');
  });
  test('a source file with a NUL byte is still read (I2)', async () => {
    const r = await repo({
      'a.ts': 'const x = "\0";\n// globex\n',
      'logo.png': Buffer.from([0, 1, 2]),
    });
    expect(scanTree(r, ['globex'])).toEqual([{ file: 'a.ts', line: 2, term: 'globex' }]);
  });
  test('a company file that does not parse never shows its text (I3)', async () => {
    const p = join(dir, 'packs', 'globex');
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'company.yaml'), 'name: Globex: Corp: x\n');
    let message = '';
    try {
      forbiddenTerms({ packDirs: [p], yamlFiles: [], env: {}, deny: [] });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/company\.yaml|pack/i);
    expect(message.toLowerCase()).not.toContain('globex');
  });
  test('reviewers, templated hosts and the bare company domain are terms; file names are scanned (I6)', async () => {
    const p = join(dir, 'packs', 'globex');
    await mkdir(p, { recursive: true });
    await writeFile(
      join(p, 'company.yaml'),
      `id: globex
projects:
  - id: portal
    pullRequest: { reviewers: [hscorpio], branchUrl: 'https://{key_lower}.dev.globex-corp.com.br/home' }
sources:
  - { id: jira, type: jira, baseUrl: https://globex.atlassian.net }
`,
    );
    const terms = forbiddenTerms({ packDirs: [p], yamlFiles: [], env: {}, deny: [] });
    expect(terms).toEqual(
      expect.arrayContaining(['hscorpio', 'dev.globex-corp.com.br', 'globex-corp.com.br']),
    );
    // A platform's own domain is never a term (only the company's host on it).
    expect(terms).not.toContain('atlassian.net');
    const r = await repo({ 'docs/hscorpio-notes.md': 'nothing\n' });
    expect(scanTree(r, ['hscorpio'])).toEqual([
      { file: 'docs/hscorpio-notes.md', line: 0, term: 'hscorpio' },
    ]);
  });
});
