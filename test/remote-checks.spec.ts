import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REMOTE_CHECKS, remoteChecksInput, RemoteChecksOutput } from '../src/checks/remote-checks';
const cfg = {
  tools: ['gitleaks', 'semgrep', 'osv'] as ('gitleaks' | 'semgrep' | 'osv')[],
  semgrep: { configs: ['p/php'] },
  blocking: true,
  reportOnly: [],
  images: { gitleaks: 'g:1', semgrep: 's:1', osv: 'o:1' },
};
let repo: string, bin: string, log: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { cwd: repo });
beforeEach(async () => {
  repo = await mkdtemp('/tmp/rchecks-');
  bin = await mkdtemp('/tmp/rchecks-bin-');
  log = resolve(bin, 'calls.log');
  // `docker` resolves to the fake in this PATH only.
  await symlink(resolve(__dirname, 'fixtures/fake-docker.sh'), resolve(bin, 'docker'));
  await chmod(resolve(__dirname, 'fixtures/fake-docker.sh'), 0o755);
  git('init', '-q');
  await mkdir(resolve(repo, 'a b'));
  await writeFile(resolve(repo, 'a b/ção.php'), '<?php\n$x = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  await writeFile(resolve(repo, 'a b/ção.php'), '<?php\neval($codigoSecreto);\n');
  await writeFile(resolve(repo, 'composer.lock'), '{}');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});
function run(files: string[]): Promise<{ out: RemoteChecksOutput; stdout: string }> {
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  return new Promise((done, fail) => {
    const child = execFile(
      'python3',
      ['-c', REMOTE_CHECKS],
      {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(stderr)) : done({ out: JSON.parse(stdout), stdout }),
    );
    child.stdin!.end(remoteChecksInput(cfg as any, base, files, 60));
  });
}
test('copies the changed files (spaces, accents), runs each tool on both sides, returns metadata only', async () => {
  const { out, stdout } = await run(['a b/ção.php', 'composer.lock', 'gone.php']);
  // semgrep: only on the current side → a new finding; its key carries a hash, not the code
  expect(out.tools.semgrep!.cur).toEqual([
    {
      key: expect.stringMatching(/^php\.lang\.security\.eval-use\|a b\/ção\.php\|[0-9a-f]{16}$/),
      finding: {
        tool: 'semgrep',
        rule: 'eval-use',
        file: 'a b/ção.php',
        line: 2,
        message: 'Evite eval',
        severity: 'ERROR',
      },
    },
  ]);
  expect(out.tools.semgrep!.base).toEqual([]);
  // gitleaks: same match on both sides (legacy) → same key
  expect(out.tools.gitleaks!.cur[0].key).toBe(out.tools.gitleaks!.base[0].key);
  // osv could not run: reported, not fatal
  expect(out.errors).toEqual([expect.stringMatching(/^osv: exit 2: .*pull access denied/s)]);
  // nothing of the code comes back
  expect(stdout).not.toContain('codigoSecreto');
  expect(stdout).not.toContain('eval(');
  // the copies are gone, the work tree is untouched
  expect(existsSync(resolve(repo, '.ai-dev-team/checks'))).toBe(false);
  expect(await readFile(resolve(repo, 'a b/ção.php'), 'utf8')).toContain('codigoSecreto');
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  expect(calls).toEqual(
    expect.arrayContaining(['gitleaks cur', 'gitleaks base', 'semgrep cur', 'semgrep base']),
  );
});
test('a file deleted or outside the folder is never copied', async () => {
  const { out } = await run(['../etc/passwd', '/etc/passwd', 'gone.php']);
  expect(out.tools).toEqual({});
  expect(out.errors).toEqual([]);
});
