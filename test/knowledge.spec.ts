import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTenants } from '../src/tenants/tenants';
import { knowledgeList, uploadKnowledge } from '../src/knowledge/knowledge';
import { renderPrompt } from '../src/prompts/prompt-files';
import { LocalWorkspace } from '../src/workspaces/local-workspace';
import { failureKind } from '../src/tasks/failure-kind';
import type { TaskWorkspace } from '../src/workspaces/task-workspace';
const tenants = (knowledge: string) => `
tenants:
  - id: acme
    name: Acme
    git: { authorName: Bot, authorEmail: bot@acme.test }
    ai: { providers: [claude], credentials: [{ id: c, provider: claude }] }
    hosts: [{ id: gh, type: github, token: t }]
    projects: [{ id: api, host: gh, repository: acme/api, test: [npm, test], knowledge: ${knowledge} }]
`;
const pack = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  mkdirSync(join(dir, 'frameworks', 'rules', 'apis'), { recursive: true });
  writeFileSync(join(dir, 'frameworks', 'rules', 'apis', 'order.yaml'), 'state: inProgress\n');
  mkdirSync(join(dir, 'maps'));
  writeFileSync(join(dir, 'maps', 'systems.yaml'), 'owner: orders\n');
  return dir;
};
const fakeWs = () => {
  const calls: string[] = [];
  const ws = {
    remove: jest.fn(async (rel: string) => void calls.push(`remove ${rel}`)),
    upload: jest.fn(
      async (local: string, rel: string) => void calls.push(`upload ${local} ${rel}`),
    ),
  };
  return { ws: ws as unknown as TaskWorkspace, calls };
};
test('a project lists the pack folders it reads, each with what it holds', () => {
  const [t] = loadTenants(tenants('[{ path: frameworks/rules, about: "the API rules" }]'), {});
  expect(t.projects[0].knowledge).toEqual([{ path: 'frameworks/rules', about: 'the API rules' }]);
  expect(loadTenants(tenants('[]'), {})[0].projects[0].knowledge).toEqual([]);
});
test.each([
  ['a path out of the pack', '[{ path: ../secrets, about: x }]'],
  ['an absolute path', '[{ path: /etc, about: x }]'],
  ['no about', '[{ path: frameworks/rules }]'],
  ['two folders of the same name', '[{ path: a/rules, about: x }, { path: b/rules, about: y }]'],
])('knowledge refuses %s', (_name, knowledge) => {
  expect(() => loadTenants(tenants(knowledge), {})).toThrow();
});
test('the folders go fresh into the task folder, under their own names', async () => {
  const dir = pack();
  const { ws, calls } = fakeWs();
  await uploadKnowledge(ws, dir, [
    { path: 'frameworks/rules', about: 'the API rules' },
    { path: 'maps/', about: 'who owns what' },
  ]);
  expect(calls).toEqual([
    'remove .ai-dev-team/knowledge',
    `upload ${join(dir, 'frameworks/rules')} .ai-dev-team/knowledge/rules`,
    `upload ${join(dir, 'maps')} .ai-dev-team/knowledge/maps`,
  ]);
  expect(knowledgeList([{ path: 'maps/', about: 'who owns what' }])).toEqual([
    '.ai-dev-team/knowledge/maps/: who owns what',
  ]);
});
test('without knowledge nothing is sent; a folder missing from the pack stops the task as configuration', async () => {
  const { ws, calls } = fakeWs();
  await uploadKnowledge(ws, undefined, []);
  expect(calls).toEqual([]);
  const missing = uploadKnowledge(ws, pack(), [{ path: 'frameworks/none', about: 'x' }]);
  await expect(missing).rejects.toMatchObject({ retryable: false });
  await expect(missing).rejects.toThrow('knowledge: folder "frameworks/none" not found');
  expect(failureKind('knowledge: folder "frameworks/none" not found in the company pack')).toBe(
    'config',
  );
});
test('a local task folder gets the copy, kept out of git; a symbolic link is refused', async () => {
  const dir = pack();
  const task = mkdtempSync(join(tmpdir(), 'task-'));
  execFileSync('git', ['init', '-q', task]);
  const ws = new LocalWorkspace({} as never, task);
  await uploadKnowledge(ws, dir, [{ path: 'frameworks/rules', about: 'x' }]);
  expect(readFileSync(join(task, '.ai-dev-team/knowledge/rules/apis/order.yaml'), 'utf8')).toBe(
    'state: inProgress\n',
  );
  expect(execFileSync('git', ['-C', task, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  await uploadKnowledge(ws, dir, [{ path: 'frameworks/rules', about: 'x' }]);
  const exclude = readFileSync(join(task, '.git/info/exclude'), 'utf8');
  expect(exclude.split('\n').filter((l) => l === '/.ai-dev-team/')).toHaveLength(1);
  symlinkSync('/etc/passwd', join(dir, 'frameworks', 'rules', 'leak'));
  await expect(ws.upload(join(dir, 'frameworks', 'rules'), 'x')).rejects.toThrow(/link/);
});
test('the core prompts list the references only when the project has some', async () => {
  const none = await renderPrompt('coder.md', { KNOWLEDGE: [] });
  expect(none).not.toContain('KNOWLEDGE');
  expect(none).not.toContain('Referências da empresa');
  const some = await renderPrompt('coder.md', {
    KNOWLEDGE: knowledgeList([{ path: 'frameworks/rules', about: 'the API rules' }]),
  });
  expect(some).toContain('Referências da empresa (somente leitura, na pasta da tarefa;');
  expect(some).toContain('- .ai-dev-team/knowledge/rules/: the API rules');
});
