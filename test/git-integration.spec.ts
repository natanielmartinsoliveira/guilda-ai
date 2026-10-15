import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { database } from './db';
import { GitService } from '../src/git/git.service';
import { ProcessRunnerService } from '../src/agents/process-runner.service';
import { Task, AgentRun } from '../src/database/entities';
test('real local git diff, testable change, fixed commit and persisted command audit', async () => {
  const db = await database(),
    path = await mkdtemp(join(tmpdir(), 'ai-dev-git-'));
  const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0',
    branch = `ai/task-${id}`;
  const task = { id, tenantId: 'acme', branch, workspace: path } as Task;
  try {
    execFileSync('git', ['init', '-b', branch, path], { stdio: 'ignore' });
    const git = new GitService(new ProcessRunnerService(db));
    await writeFile(join(path, 'hello.txt'), 'before\n');
    await git.git(task, ['add', '.']);
    await git.git(task, ['commit', '-m', 'initial'], { author: { name: 'T', email: 't@t.test' } });
    await writeFile(join(path, 'hello.txt'), 'after\n');
    expect((await git.validateChanges(task)).files).toEqual(['hello.txt']);
    const sha = await git.commit(task, 'feat(ai): implement #7', { name: 'T', email: 't@t.test' });
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await git.git(task, ['log', '-1', '--format=%s'])).toBe('feat(ai): implement #7');
    expect(await db.getRepository(AgentRun).count()).toBeGreaterThan(4);
  } finally {
    await rm(path, { recursive: true, force: true });
    await db.destroy();
  }
});
test('test side effects are reverted, the agent change is kept (real git)', async () => {
  const { mkdir, readFile, unlink } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const db = await database(),
    path = await mkdtemp(join(tmpdir(), 'ai-dev-git-'));
  const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0';
  const task = { id, tenantId: 'acme', branch: `ai/task-${id}`, workspace: path } as Task;
  try {
    execFileSync('git', ['init', '-b', task.branch, path], { stdio: 'ignore' });
    const git = new GitService(new ProcessRunnerService(db));
    await mkdir(join(path, 'tests/Fixtures'), { recursive: true });
    await writeFile(join(path, 'tests/Fixtures/test-file.png'), 'png');
    await writeFile(join(path, 'app.php'), 'v1\n');
    await git.git(task, ['add', '.']);
    await git.git(task, ['commit', '-m', 'initial'], { author: { name: 'T', email: 't@t.test' } });
    // The agent changes app.php and adds a new test file...
    await writeFile(join(path, 'app.php'), 'v2\n');
    await writeFile(join(path, 'NewTest.php'), 'test\n');
    const before = await git.changedPaths(task);
    // ...then the test run deletes a tracked fixture and leaves a report behind.
    await unlink(join(path, 'tests/Fixtures/test-file.png'));
    await writeFile(join(path, 'report.xml'), '<xml/>');
    expect((await git.revertSideEffects(task, before)).sort()).toEqual([
      'report.xml',
      'tests/Fixtures/test-file.png',
    ]);
    expect(await readFile(join(path, 'tests/Fixtures/test-file.png'), 'utf8')).toBe('png');
    expect(existsSync(join(path, 'report.xml'))).toBe(false);
    expect(await readFile(join(path, 'app.php'), 'utf8')).toBe('v2\n');
    expect((await git.validateChanges(task)).files.sort()).toEqual(['NewTest.php', 'app.php']);
  } finally {
    await rm(path, { recursive: true, force: true });
    await db.destroy();
  }
});
test('hidden files leave the work tree, stay in the repository and survive resets (real git)', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const db = await database(),
    path = await mkdtemp(join(tmpdir(), 'ai-dev-git-'));
  const id = '36c96583-9ca3-4f12-9d76-0588b0352ae0';
  const task = { id, tenantId: 'acme', branch: `ai/task-${id}`, workspace: path } as Task;
  const author = { name: 'T', email: 't@t.test' };
  const key = join(path, '.saml-configurations/765 (movidesk)/private.key');
  try {
    execFileSync('git', ['init', '-b', task.branch, path], { stdio: 'ignore' });
    const git = new GitService(new ProcessRunnerService(db));
    await mkdir(join(path, '.saml-configurations/765 (movidesk)'), { recursive: true });
    await writeFile(key, '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n');
    await writeFile(join(path, 'app.php'), 'v1\n');
    await git.git(task, ['add', '.']);
    await git.git(task, ['commit', '-m', 'initial'], { author });
    await expect(git.assertNoCredentials(task)).rejects.toThrow('protected credential file');
    await git.hide(task, ['.saml-configurations/**/*.key']);
    expect(existsSync(key)).toBe(false);
    await git.assertNoCredentials(task);
    // The worker resets to the base before every agent run: the file must stay hidden.
    await git.resetTo(task, await git.git(task, ['rev-parse', 'HEAD']));
    expect(existsSync(key)).toBe(false);
    // An agent change is committed without deleting the hidden file from the repository.
    await writeFile(join(path, 'app.php'), 'v2\n');
    expect((await git.validateChanges(task)).files).toEqual(['app.php']);
    await git.commit(task, 'feat(ai): change', author);
    expect(await git.git(task, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain(
      '.saml-configurations/765 (movidesk)/private.key',
    );
  } finally {
    await rm(path, { recursive: true, force: true });
    await db.destroy();
  }
});
