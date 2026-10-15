import { GitService } from '../src/git/git.service';
import { TaskWorkspaces } from '../src/workspaces/task-workspaces.service';
import { loadTenants, useTenants } from '../src/tenants/tenants';
import { workspace } from '../src/config';
import { coderTenantYaml } from './fixtures/coder-tenant';
const ID = '22222222-2222-4222-8222-222222222222';
const cfg = {
  type: 'coder' as const,
  url: 'https://c.example.com',
  name: 'ws',
  root: '/root/ai',
  reference: '/workspaces/svc',
  protect: ['/workspaces'],
};
function setup(answers: [string, string][] = []) {
  const lines: string[] = [];
  const run = jest.fn(async (_bin: string, args: string[]) => {
    const line = args.at(-1) ?? args.join(' ');
    lines.push(line);
    for (const [k, v] of answers)
      if (line.includes(k)) return { success: true, exitCode: 0, stdout: v, stderr: '' };
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  });
  const runner = { run } as any;
  const workspaces = new TaskWorkspaces(runner);
  const task = {
    id: ID,
    tenantId: 'initech',
    branch: '49145-fix',
    workspace: workspace('initech', ID),
  } as any;
  workspaces.bind(task, cfg);
  return { git: new GitService(runner, workspaces), task, lines, run };
}
test('coder clone: inside the workspace, ssh url, reference + dissociate, then moved into place', async () => {
  const { git, task, lines, run } = setup([
    ['echo missing', 'missing\n'],
    ['--show-current', '49145-fix'],
  ]);
  await git.prepare(
    task,
    'homolog',
    {
      url: 'ssh://git.example.com:2244/shop/svc.git',
      authHeader: '',
    },
    { newBranch: true },
  );
  // every command went through coder ssh, none ran git on this machine
  expect(run.mock.calls.every(([bin]) => bin !== 'git')).toBe(true);
  const clone = lines.find((l) => l.includes('clone'))!;
  expect(clone).toContain('--reference');
  expect(clone).toContain('/workspaces/svc');
  expect(clone).toContain('--dissociate');
  expect(clone).toContain('ssh://git.example.com:2244/shop/svc.git');
  expect(clone).toContain(`${ID}.partial`);
  expect(clone).toContain(`cd '\\''/root/ai'\\''`);
  expect(lines.some((l) => l.includes(`'\\''mv'\\''`) && l.includes(`${ID}.partial`))).toBe(true);
  // never a cd into the operator's clones (reference is only read by git)
  expect(lines.some((l) => l.includes(`cd '\\''/workspaces`))).toBe(false);
  // ssh remote: no http extraheader in the environment
  expect(clone).not.toContain('extraheader');
});
test('credential check reads PEM content through the workspace, not this disk', async () => {
  const { git, task, lines } = setup([
    ['ls-files', 'H keys/a.pem\0'],
    ["'\\''head'\\''", '-----BEGIN RSA PRIVATE KEY-----'],
  ]);
  await expect(git.assertNoCredentials(task)).rejects.toThrow(/keys\/a.pem/);
  expect(lines.some((l) => l.includes('head') && l.includes('keys/a.pem'))).toBe(true);
});
test('a symlink change is checked in the workspace', async () => {
  const { git, task } = setup([
    ['--show-current', '49145-fix'],
    ['--name-only', 'link\0'],
  ]);
  // test -L answers success (default answer) → refused
  await expect(git.validateChanges(task)).rejects.toThrow(/Symlink change refused: link/);
});
test('a task of a coder company that was never bound is refused, never cloned here (focus 4)', () => {
  const runner = { run: jest.fn() } as any;
  const workspaces = new TaskWorkspaces(runner);
  useTenants(loadTenants(coderTenantYaml()));
  try {
    expect(() =>
      workspaces.of({ id: ID, tenantId: 'initech', workspace: workspace('initech', ID) } as any),
    ).toThrow(/not bound/);
  } finally {
    useTenants(undefined);
  }
  // a company without coder projects keeps the local folder
  expect(
    workspaces.of({ id: ID, tenantId: 'acme', workspace: workspace('acme', ID) } as any).kind,
  ).toBe('local');
});
test('a remote with its own ssh command: git in the workspace uses it (no host key prompt)', async () => {
  const { git, task, lines } = setup([
    ['echo missing', 'missing\n'],
    ['--show-current', '49145-fix'],
  ]);
  await git.prepare(
    task,
    'homolog',
    {
      url: 'ssh://git@git.example.com:2244/shop/svc.git',
      authHeader: '',
      sshCommand: 'coder gitssh -- -o BatchMode=yes',
    },
    { newBranch: true },
  );
  const clone = lines.find((l) => l.includes('clone'))!;
  expect(clone).toContain('GIT_SSH_COMMAND=');
  expect(clone).toContain('BatchMode=yes');
});
