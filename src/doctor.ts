import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { tenants } from './tenants/tenants';
let failed = false;
for (const [bin, args] of [
  ['node', ['--version']],
  ['git', ['--version']],
  ['bwrap', ['--version']],
  [process.env.CODEX_BIN ?? 'codex', ['--help']],
  [process.env.CODEX_BIN ?? 'codex', ['exec', '--help']],
  [process.env.CLAUDE_BIN ?? 'claude', ['--help']],
] as [string, string[]][]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  console.log(
    JSON.stringify({ bin, args, status: r.status, error: r.error?.message, help: r.stdout }),
  );
  if (r.status !== 0) failed = true;
}
try {
  const loaded = tenants();
  console.log(
    JSON.stringify({
      tenants: loaded.map((t) => ({
        id: t.id,
        providers: t.ai.providers,
        credentials: t.ai.credentials.map(
          (c) =>
            `${c.id}:${c.provider}${c.model ? `/${c.model}` : ''}:${c.apiKey ? 'key' : 'login'}`,
        ),
        projects: t.projects.map((p) => p.repository),
        sources: t.sources.map((s) => `${s.id}:${s.type}`),
      })),
    }),
  );
  // Projects testing in containers need the daemon and their (pre-built) images.
  const images = [
    ...new Set(
      loaded.flatMap((t) => t.projects.flatMap((p) => (p.runner ? [p.runner.image] : []))),
    ),
  ];
  const docker = process.env.DOCKER_BIN ?? 'docker';
  for (const args of images.length
    ? [['version'], ...images.map((i) => ['image', 'inspect', i])]
    : []) {
    const r = spawnSync(docker, args, { encoding: 'utf8', timeout: 30000 });
    console.log(JSON.stringify({ bin: docker, args: args.slice(0, 3), status: r.status }));
    if (r.status !== 0) failed = true;
  }
} catch (error) {
  console.error((error as Error).message);
  failed = true;
}
if (process.getuid?.() === 0) {
  console.error('Worker must not run as root');
  failed = true;
}
process.exitCode = failed ? 1 : 0;
