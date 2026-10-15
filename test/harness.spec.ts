import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarness } from '../src/agents/harness';
import { ClaudeProvider } from '../src/agents/claude.provider';
import { CodexProvider } from '../src/agents/codex.provider';
import { SandboxService } from '../src/agents/sandbox.service';
import { loadTenants } from '../src/tenants/tenants';
let root: string;
const file = async (path: string, content = 'x') => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
};
beforeEach(async () => {
  // Same layout as the company's harness repository (tools-hub).
  root = await mkdtemp(join(tmpdir(), 'harness-'));
  await file('products/avaliacoes/skills/vandelay-coding/SKILL.md');
  await file('products/avaliacoes/skills/vandelay-review/SKILL.md');
  await file('products/avaliacoes/skills/_template/SKILL.md');
  await file('products/avaliacoes/skills/README.md');
  await file('products/avaliacoes/skills/no-manifest/notes.md');
  await file('products/avaliacoes/agents/vandelay-coder/AGENT.md');
  await file('products/avaliacoes/agents/README.md');
  await file('common/skills/vandelay-coding/SKILL.md');
  await file('common/skills/shared-skill/SKILL.md');
  await file('common/agents/helper.md');
  await file('common/prompts/rules.md', 'Sempre never-throw.');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const config = () => ({
  path: root,
  skills: ['products/avaliacoes/skills', 'common/skills'],
  agents: ['products/avaliacoes/agents', 'common/agents'],
  instructions: 'common/prompts/rules.md',
});
test('resolves skills, agents and instructions like the official installer', async () => {
  const h = await resolveHarness(config());
  expect(h.skills.map((s) => s.name)).toEqual([
    'vandelay-coding',
    'vandelay-review',
    'shared-skill',
  ]);
  // On a name clash the first folder listed wins (product over common).
  expect(h.skills[0].path).toContain('products/avaliacoes/skills/vandelay-coding');
  expect(h.agents.map((a) => [a.name, a.path.split('/').slice(-2).join('/')])).toEqual([
    ['vandelay-coder', 'vandelay-coder/AGENT.md'],
    ['helper', 'agents/helper.md'],
  ]);
  expect(h.instructions).toMatch(/common\/prompts\/rules\.md$/);
});
test('refuses symlinks escaping the harness and missing folders', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-skill-'));
  await writeFile(join(outside, 'SKILL.md'), 'x');
  await symlink(outside, join(root, 'products/avaliacoes/skills/evil'));
  await expect(resolveHarness(config())).rejects.toThrow('escapes its root');
  await rm(outside, { recursive: true, force: true });
  await expect(resolveHarness({ ...config(), skills: ['nope'] })).rejects.toThrow(
    'Harness folder not found',
  );
  await expect(resolveHarness({ ...config(), path: '/does/not/exist' })).rejects.toThrow(
    'Harness not found',
  );
});
test('configuration accepts only absolute roots and relative paths inside them', () => {
  const yaml = (harness: string) => `
tenants:
  - id: t
    name: T
    git: { authorName: B, authorEmail: b@t.test }
    harness: ${harness}
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [{ id: gh, type: github, token: x }]
    projects: [{ id: api, host: gh, repository: t/api, test: [npm, test] }]
`;
  expect(loadTenants(yaml('{ path: /h, skills: [a/b] }'), {})[0].harness).toEqual({
    path: '/h',
    skills: ['a/b'],
    agents: [],
  });
  expect(() => loadTenants(yaml('{ path: h }'), {})).toThrow('absolute path');
  expect(() => loadTenants(yaml('{ path: /h, skills: [../x] }'), {})).toThrow('relative path');
});
const help = (extra: string) => ({
  success: true,
  stdout: `--print --output-format --permission-mode --ask-for-approval --json --sandbox ${extra}`,
  stderr: '',
  exitCode: 0,
});
const input = {
  taskId: 't',
  tenantId: 'acme',
  credentialId: 'c',
  workspace: '/w',
  prompt: 'p',
  timeoutMs: 1000,
};
test('Claude loads the harness in its throwaway home and no longer runs in safe mode', async () => {
  const harness = await resolveHarness(config());
  const sandbox = { run: jest.fn().mockResolvedValue({ ...help(''), stdout: '{}' }) };
  await new ClaudeProvider(
    {
      run: jest
        .fn()
        .mockResolvedValue(
          help('--setting-sources --strict-mcp-config --append-system-prompt --safe-mode'),
        ),
    } as any,
    sandbox as any,
  ).execute({ ...input, harness });
  const [, args, opts] = sandbox.run.mock.calls[0];
  expect(args).not.toContain('--safe-mode');
  expect(args).toEqual(
    expect.arrayContaining(['--setting-sources', 'user', '--strict-mcp-config']),
  );
  expect(args.join(' ')).toContain(
    '--append-system-prompt-file /home/agent/harness-instructions.md',
  );
  expect(opts.homeMounts).toEqual(
    expect.arrayContaining([
      { source: harness.skills[0].path, target: '/home/agent/.claude/skills/vandelay-coding' },
      { source: harness.agents[0].path, target: '/home/agent/.claude/agents/vandelay-coder.md' },
      { source: harness.instructions, target: '/home/agent/harness-instructions.md' },
    ]),
  );
});
test('Codex gets the instructions as its global AGENTS.md and the skills', async () => {
  const harness = await resolveHarness(config());
  const sandbox = { run: jest.fn().mockResolvedValue(help('')) };
  await new CodexProvider(
    { run: jest.fn().mockResolvedValue(help('')) } as any,
    sandbox as any,
  ).execute({ ...input, harness });
  const mounts = sandbox.run.mock.calls[0][2].homeMounts;
  expect(mounts[0]).toEqual({
    source: harness.instructions,
    target: '/home/agent/.codex/AGENTS.md',
  });
  expect(mounts.map((m: { target: string }) => m.target)).toContain(
    '/home/agent/.codex/skills/vandelay-coding',
  );
});
test('sandbox never mounts harness content outside the agent home', async () => {
  const { mkdir: mk } = await import('node:fs/promises');
  const { workspace, config: settings } = await import('../src/config');
  const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0',
    cwd = workspace('acme', id),
    runner = { run: jest.fn() };
  await mk(cwd, { recursive: true });
  try {
    for (const target of ['/workspace/.github', '/home/agent/../../etc/x'])
      await expect(
        new SandboxService(runner as any).run('node', [], {
          cwd,
          taskId: id,
          tenantId: 'acme',
          timeoutMs: 1000,
          homeMounts: [{ source: join(root, 'common/prompts/rules.md'), target }],
        }),
      ).rejects.toThrow('outside the agent home');
    expect(runner.run).not.toHaveBeenCalled();
  } finally {
    await rm(settings().WORKSPACE_ROOT, { recursive: true, force: true });
  }
});
