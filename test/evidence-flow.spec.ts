import { EXAMPLE_METHOD, METHOD_PACK, methodRun } from './fixtures/method-ws';
import { DataSource } from 'typeorm';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { database, item } from './db';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { AgentRouter } from '../src/agents/agent-router.service';
import { Decision, Task } from '../src/database/entities';
import { authorizationFor } from './fixtures/method-ws';
import { EVIDENCE_DIR } from '../src/evidence/evidence';
import { evidenceDir } from '../src/evidence/evidence-store';
let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
  jest.restoreAllMocks();
});
const CODER = {
  type: 'coder' as const,
  url: 'https://coder.example.com',
  name: 'ws',
  root: '/root/ai',
  reference: '/workspaces/svc',
  protect: ['/workspaces'],
};
const SHOT = { file: '01-tela.png', title: 'Tela', url: 'http://localhost:3000/x', at: 'T' };
type Script = {
  /** Answers of the evidence runs, in order. */
  evidence?: string[];
  manifest?: string;
  withEvidence?: boolean;
  route?: 'fix' | 'direct';
  /** What the evidence agent leaves behind in the project: a commit and stray files. */
  evidenceLeaves?: { commit?: boolean; files?: string[] };
};
async function setup(script: Script = {}) {
  const registry = new TenantRegistry();
  const orchestrator = new OrchestratorService(db, registry);
  const task = await orchestrator.accept('acme', {
    ...item,
    delivery: { route: script.route ?? 'fix' } as any,
  });
  let head = 'a'.repeat(40);
  // The task folder's uncommitted files, as git status would list them.
  let tree: string[] = [];
  const git = {
    prepare: jest.fn(),
    git: jest.fn(async (_t: unknown, args: string[]) => {
      if (args[0] === 'rev-parse') return head;
      if (args[0] === 'status') return tree.map((p) => `?? ${p}\0`).join('');
      if (args[0] === 'reset') head = args[2];
      if (args[0] === 'reset' || args[0] === 'clean') tree = [];
      return '';
    }),
    commit: jest.fn(),
    commitPaths: jest.fn(async () => (head = 'c'.repeat(40))),
    push: jest.fn(),
    changedSince: jest.fn(async () => ['src/x.php']),
    changedPaths: jest.fn(async () => ({ tracked: [], untracked: [] })),
    revertSideEffects: jest.fn(async () => [] as string[]),
    validateChanges: jest.fn().mockResolvedValue({ files: ['src/x.php'], diff: '1 file' }),
    resetTo: jest.fn(),
    remoteBranchExists: jest.fn(async () => false),
    diff: jest.fn(),
    fetchBranch: jest.fn(),
  };
  const evidence = [...(script.evidence ?? ['<resultado>concluido</resultado>'])];
  const order: string[] = [];
  const agents = {
    execute: jest.fn(async (_p: string, input: { prompt: string }) => {
      const kind = input.prompt.includes('roteiro.cjs') ? 'evidence' : 'deliver';
      order.push(kind);
      if (kind === 'evidence' && script.evidenceLeaves) {
        if (script.evidenceLeaves.commit) head = 'e'.repeat(40);
        tree = script.evidenceLeaves.files ?? [];
      }
      return {
        success: true,
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        message: kind === 'evidence' ? evidence.shift() : '<resultado>concluido</resultado>',
      };
    }),
  };
  const hooks = methodRun(() => ({ spec_root: 'docs/spec', direct_edits: true }));
  const uploaded: { rel: string; files: string[]; version: string }[] = [];
  const ws = {
    kind: 'coder',
    root: '/root/ai',
    label: 'ws:/root/ai/t',
    attachmentsPath: '/root/ai/t/.ai-dev-team/attachments',
    run: jest.fn(async (argv: string[], opts?: { input?: string }) => {
      // The method's hooks are not the project's commands.
      if (!String(argv[1] ?? '').startsWith('.ai-dev-team/method/')) order.push('command');
      return hooks(argv, opts);
    }),
    readText: jest.fn(async (rel: string) =>
      rel === `${EVIDENCE_DIR}/out/manifest.json`
        ? (script.manifest ?? JSON.stringify({ shots: [SHOT] }))
        : undefined,
    ),
    readFile: jest.fn(async (rel: string) =>
      rel.endsWith('.png') || rel.endsWith('trace.zip')
        ? Buffer.from(`bytes of ${rel}`)
        : undefined,
    ),
    upload: jest.fn(async (dir: string, rel: string) => {
      if (rel !== EVIDENCE_DIR) return; // the method hooks travel too
      uploaded.push({
        rel,
        files: (await readdir(dir)).sort(),
        version: await readFile(join(dir, 'version'), 'utf8'),
      });
    }),
    remove: jest.fn(async () => {}),
  };
  const project = registry.project.bind(registry);
  jest.spyOn(registry, 'project').mockImplementation((t, id) => {
    const ctx = project(t, id);
    return {
      ...ctx,
      host: { id: 'gl', cloneUrl: () => 'ssh://git/x.git', gitAuthHeader: () => '' },
      tenant: { ...ctx.tenant, packDir: METHOD_PACK },
      project: {
        ...ctx.project,
        workspace: CODER,
        delivery: 'rehearsal',
        method: EXAMPLE_METHOD,
        ...(script.withEvidence === false
          ? {}
          : { evidence: { playwright: '1.48.2', timeoutMinutes: 30 } }),
      },
    } as any;
  });
  const worker = new TaskWorkerService(
    db,
    {} as any,
    new AgentRouter(db, agents as any),
    {} as any,
    git as any,
    registry,
    { report: jest.fn() } as any,
    { run: jest.fn() } as any,
    orchestrator,
    { run: jest.fn() } as any,
    { prepare: jest.fn() } as any,
    { bind: () => ws, of: () => ws } as any,
  );
  const run = () =>
    worker.handle(
      {
        content: Buffer.from(
          JSON.stringify({ taskId: task.id, issueId: task.issueId, type: 'CODE' }),
        ),
      } as any,
      { ack: jest.fn(), nack: jest.fn() } as any,
    );
  const answerOpen = async (answer: string) => {
    const open = await db
      .getRepository(Decision)
      .findOneByOrFail({ taskId: task.id, status: 'open' });
    await orchestrator.answerDecision('acme', open.id, { answers: [answer] }, 'web');
    return open;
  };
  const reload = () => db.getRepository(Task).findOneByOrFail({ id: task.id });
  const prompts = () => agents.execute.mock.calls.map((c) => (c[1] as { prompt: string }).prompt);
  // The gate first: the person authorizes the fix.
  if ((script.route ?? 'fix') === 'fix') {
    await run();
    await answerOpen(authorizationFor('fix', task.branch));
  }
  return { task, ws, run, answerOpen, reload, prompts, uploaded, order, git };
}

test('after the delivery the agent runs the kit; framed prints and the comment come back', async () => {
  const x = await setup();
  await x.run();
  const task = await x.reload();
  expect(task.stage).toBe('REHEARSED');
  // delivery, its tests, then the evidence run
  expect(x.order.indexOf('evidence')).toBeGreaterThan(x.order.lastIndexOf('command'));
  const prompt = x.prompts().find((p) => p.includes('roteiro.cjs'))!;
  expect(prompt).toContain('Playwright 1.48.2');
  expect(prompt).toContain(item.title);
  expect(x.uploaded).toEqual([
    {
      rel: EVIDENCE_DIR,
      files: ['evidence-kit.cjs', 'run.sh', 'timezone', 'version'],
      version: '1.48.2',
    },
  ]);
  const evidence = task.result!.evidence as { shots: unknown[]; comment: string; trace?: string };
  expect(evidence.shots).toEqual([SHOT]);
  expect(evidence.comment.startsWith('Evidência de teste')).toBe(true);
  expect(evidence.trace).toBe('trace.zip');
  const dir = evidenceDir('acme', task.id);
  expect(await readFile(join(dir, '01-tela.png'), 'utf8')).toBe(
    `bytes of ${EVIDENCE_DIR}/out/01-tela.png`,
  );
  // the kit folder never stays in the workspace, and nothing of it is committed
  expect(x.ws.remove).toHaveBeenLastCalledWith(EVIDENCE_DIR);
  expect(x.git.commitPaths).not.toHaveBeenCalled();
  expect(x.git.commit).not.toHaveBeenCalled();
});

test('an evidence run that did not reach the result asks; the answer guides the next run', async () => {
  const x = await setup({
    evidence: [
      '<resultado>pendente</resultado><pendencias>Preciso de uma venda com oferta</pendencias>',
      '<resultado>concluido</resultado>',
    ],
  });
  await x.run();
  let task = await x.reload();
  expect(task.status).toBe('WAITING');
  const asked = await x.answerOpen('use a venda 1af8bc91');
  expect(asked.questions![0].text).toContain('Preciso de uma venda com oferta');
  await x.run();
  task = await x.reload();
  expect(task.stage).toBe('REHEARSED');
  const runs = x.prompts().filter((p) => p.includes('roteiro.cjs'));
  expect(runs).toHaveLength(2);
  expect(runs[1]).toContain('use a venda 1af8bc91');
});

test('a manifest that does not hold is a question, never a print', async () => {
  const x = await setup({
    manifest: JSON.stringify({ shots: [{ ...SHOT, file: '../../etc/passwd' }] }),
  });
  await x.run();
  const task = await x.reload();
  expect(task.status).toBe('WAITING');
  const open = await db
    .getRepository(Decision)
    .findOneByOrFail({ taskId: task.id, status: 'open' });
  expect(open.questions![0].text).toMatch(/arquivo de print inválido/);
  expect(task.result?.evidence).toBeUndefined();
  expect(x.ws.readFile).not.toHaveBeenCalledWith(
    expect.stringContaining('passwd'),
    expect.anything(),
  );
});

test('a project without evidence configured has no evidence step', async () => {
  const x = await setup({ withEvidence: false });
  await x.run();
  const task = await x.reload();
  expect(task.stage).toBe('REHEARSED');
  expect(x.prompts().some((p) => p.includes('roteiro.cjs'))).toBe(false);
  expect(x.ws.upload.mock.calls.filter(([, rel]) => rel === EVIDENCE_DIR)).toHaveLength(0);
});

test('the direct route (a direct edit) gets evidence too, before the rehearsal ends', async () => {
  const x = await setup({ route: 'direct' });
  await x.run();
  const task = await x.reload();
  expect(task.stage).toBe('REHEARSED');
  expect(x.prompts().some((p) => p.includes('roteiro.cjs'))).toBe(true);
  expect((task.result!.evidence as { shots: unknown[] }).shots).toEqual([SHOT]);
});

test('what the evidence agent leaves in the project is undone, never delivered', async () => {
  const x = await setup({
    evidenceLeaves: { commit: true, files: ['docker-compose.override.yml'] },
  });
  await x.run();
  const task = await x.reload();
  expect(task.stage).toBe('REHEARSED');
  const delivered = task.result!.commitSha;
  expect(delivered).toBe('a'.repeat(40));
  const calls = x.git.git.mock.calls.map(([, a]) => a.join(' '));
  expect(calls).toContain(`reset --hard ${delivered}`);
  expect(calls).toContain('clean -fd');
});
