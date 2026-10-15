import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChecksService, checksSummary } from '../src/checks/checks.service';
import { config, workspace } from '../src/config';
import { loadTenants } from '../src/tenants/tenants';
const id = '5d1c1a52-8b5e-4e3a-9f0e-1f2d3c4b5a69';
const base = 'a'.repeat(40);
const ws = workspace('acme', id);
const task = { id, tenantId: 'acme', workspace: ws, branch: 'ai/task-x' } as never;
const cfg = {
  tools: ['gitleaks', 'semgrep', 'osv'] as ('gitleaks' | 'semgrep' | 'osv')[],
  scope: '(^|/)[^/]*apprais[^/]*(/|$)',
  semgrep: { configs: ['p/php'] },
  blocking: true,
  reportOnly: [] as ('gitleaks' | 'semgrep' | 'osv')[],
  images: { gitleaks: 'gl:1', semgrep: 'sg:1', osv: 'osv:1' },
};
async function file(path: string, content: string) {
  await mkdir(dirname(`${ws}/${path}`), { recursive: true });
  await writeFile(`${ws}/${path}`, content);
}
beforeEach(async () => {
  await mkdir(`${ws}/.git`, { recursive: true });
});
afterEach(async () => {
  await rm(config().WORKSPACE_ROOT, { recursive: true, force: true });
});
/** Fake tools: report what the copied files contain, like the real ones would. */
function setup(baseFiles: Record<string, string>) {
  const git = {
    changedSince: jest.fn(async () => Object.keys(current)),
    fileAt: jest.fn(async (_t: unknown, _s: string, p: string) =>
      p in baseFiles ? Buffer.from(baseFiles[p]) : undefined,
    ),
  };
  const current: Record<string, string> = {};
  const containers = {
    run: jest.fn(
      async (
        runner: { image: string; network: string },
        argv: string[],
        opts: { mounts: { source: string; target: string; writable?: boolean }[] },
      ) => {
        const { source, target } = opts.mounts[0];
        const outDir = opts.mounts.find((m) => m.writable)!.source;
        const reply = async (report: unknown, exitCode = 0, stdout = '') => {
          if (report !== undefined)
            await writeFile(`${outDir}/report.json`, JSON.stringify(report));
          return { success: exitCode === 0, exitCode, stdout, stderr: '' };
        };
        const read = async (rel: string) => readFile(`${source}/${rel}`, 'utf8').catch(() => '');
        if (runner.image === 'sg:1') {
          const results: unknown[] = [];
          for (const path of argv.filter((a) => a.startsWith(`${target}/`))) {
            const lines = (await read(path.slice(target.length + 1))).split('\n');
            lines.forEach((l, i) => {
              if (l.includes('$_GET'))
                results.push({
                  check_id: 'php.lang.security.tainted-sql',
                  path,
                  start: { line: i + 1 },
                  end: { line: i + 1 },
                  extra: { message: 'SQL com entrada do usuário', severity: 'ERROR' },
                });
            });
          }
          return reply({ results });
        }
        if (runner.image === 'gl:1') {
          const leaks = [];
          for (const rel of ['src/Core/Appraisal/Service.php', 'config/app.php']) {
            const content = await read(rel);
            const m = content.match(/SECRET_[A-Z0-9]+/g) ?? [];
            for (const s of m)
              leaks.push({
                RuleID: 'generic-api-key',
                File: `${target}/${rel}`,
                StartLine: 1,
                Match: s,
                Description: 'segredo',
              });
          }
          return reply(leaks);
        }
        const lock = await read('composer.lock');
        if (!lock) return reply(undefined, 128, 'No package sources found');
        const vulns = lock.includes('guzzle 6')
          ? [{ id: 'GHSA-guzzle', summary: 'falha no guzzle' }]
          : [];
        return reply(
          {
            results: [
              {
                source: { path: `${target}/composer.lock` },
                packages: [{ package: { name: 'guzzle', version: '6' }, vulnerabilities: vulns }],
              },
            ],
          },
          vulns.length ? 1 : 0,
        );
      },
    ),
  };
  return { git, containers, current, service: new ChecksService(git as any, containers as any) };
}
test('only findings the change introduces count; scope limits the code analysis', async () => {
  const legacy = '<?php\n$q = "SELECT * FROM t WHERE id=" . $_GET["id"];\n';
  const x = setup({ 'src/Core/Appraisal/Service.php': legacy, 'config/app.php': '<?php\n' });
  // Legacy finding moved down one line by the change: still not "new".
  x.current['src/Core/Appraisal/Service.php'] =
    `<?php\n// novo\n$q = "SELECT * FROM t WHERE id=" . $_GET["id"];\n$k = "SECRET_NEW1";\n$r = "x" . $_GET["r"];\n`;
  // Outside the scope: semgrep ignores it, gitleaks still checks it.
  x.current['config/app.php'] = '<?php\n$p = $_GET["p"]; $t = "SECRET_OUT";\n';
  for (const [p, c] of Object.entries(x.current)) await file(p, c);
  const r = await x.service.run(task, cfg, base);
  expect(r.findings.map((f) => [f.tool, f.file, f.line])).toEqual([
    ['gitleaks', 'src/Core/Appraisal/Service.php', 1],
    ['gitleaks', 'config/app.php', 1],
    ['semgrep', 'src/Core/Appraisal/Service.php', 5],
  ]);
  expect(r.tools).toEqual({
    gitleaks: { files: 2, now: 2, base: 0 },
    semgrep: { files: 1, now: 2, base: 1 },
  });
  // osv only runs when a lockfile changed.
  expect(x.containers.run.mock.calls.map((c) => c[0].image)).not.toContain('osv:1');
  // Tools run without network except where they must download rules or query advisories.
  const networks = Object.fromEntries(
    x.containers.run.mock.calls.map((c) => [c[0].image, c[0].network]),
  );
  expect(networks).toEqual({ 'gl:1': 'none', 'sg:1': 'bridge' });
  // Snapshots are removed afterwards.
  await expect(
    readFile(`${config().WORKSPACE_ROOT}/acme/.checks-${id}/cur/config/app.php`),
  ).rejects.toThrow();
});
test('a dependency added to a lockfile is checked against its base version', async () => {
  const x = setup({});
  x.current['composer.lock'] = 'guzzle 6';
  await file('composer.lock', 'guzzle 6');
  const r = await x.service.run(task, { ...cfg, tools: ['osv'] }, base);
  expect(r.findings).toEqual([
    {
      tool: 'osv',
      rule: 'GHSA-guzzle',
      file: 'composer.lock',
      message: 'guzzle@6: falha no guzzle',
    },
  ]);
  expect(r.errors).toEqual([]);
});
test('a tool that cannot run is reported, not blocking', async () => {
  const x = setup({});
  x.containers.run.mockResolvedValue({
    success: false,
    exitCode: 2,
    stdout: '',
    stderr: 'pull access denied',
  });
  x.current['a.php'] = '<?php';
  await file('a.php', '<?php');
  const r = await x.service.run(task, { ...cfg, tools: ['gitleaks'], scope: undefined }, base);
  expect(r.findings).toEqual([]);
  expect(r.errors[0]).toContain('gitleaks: exit 2: pull access denied');
  expect(checksSummary({ ...r, blocking: true })).toContain('⚠️ não executou: gitleaks');
});
test('configuration: semgrep needs rule sets; scope must be a valid regex', () => {
  const yaml = (checks: string) => `
tenants:
  - id: acme
    name: Acme
    git: { authorName: Bot, authorEmail: bot@acme.test }
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [{ id: gh, type: github, token: tok }]
    projects: [{ id: api, host: gh, repository: acme/api, test: [npm, test], checks: ${checks} }]
`;
  const [t] = loadTenants(yaml('{ tools: [gitleaks] }'));
  expect(t.projects[0].checks).toMatchObject({
    blocking: true,
    images: { gitleaks: 'ghcr.io/gitleaks/gitleaks:latest' },
  });
  expect(() => loadTenants(yaml('{ tools: [semgrep] }'))).toThrow('semgrep needs semgrep.configs');
  expect(() => loadTenants(yaml("{ tools: [gitleaks], scope: '(' }"))).toThrow('invalid regex');
});
