import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api';
import { renderWithLive } from '../test-utils';
import type { DecisionView, TaskView, Tenant } from '../types';
import { Tasks } from './Tasks';
afterEach(() => vi.restoreAllMocks());
const tenants: Tenant[] = [
  {
    id: 'acme',
    name: 'Acme',
    providers: [],
    jira: true,
    projects: [
      { id: 'web', repository: 'a/web' },
      { id: 'api', repository: 'a/api' },
    ],
  },
  {
    id: 'globex',
    name: 'Globex',
    providers: [],
    jira: false,
    projects: [{ id: 'site', repository: 'g/site' }],
  },
];
const task = (over: Partial<TaskView>): TaskView => ({
  id: 't1',
  tenantId: 'acme',
  project: 'web',
  branch: 'ai/pf-1',
  key: 'PF-1',
  title: 'Primeira',
  status: 'RUNNING',
  stage: 'TESTS',
  provider: 'claude',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: '2026-10-06T10:00:00Z',
  updatedAt: '2026-10-06T10:00:00Z',
  ...over,
});
const tasks = [
  task({}),
  task({
    id: 't2',
    key: 'PF-2',
    title: 'Segunda',
    project: 'api',
    status: 'FAILED',
    stage: 'AGENT',
  }),
  task({
    id: 't3',
    tenantId: 'globex',
    project: 'site',
    key: 'T-3',
    title: 'Terceira',
    status: 'SUCCESS',
    stage: 'DONE',
    prUrl: 'https://pr/3',
  }),
];
const listed = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
const detailAt = (id: string) => ({
  path: `/tarefas/acme/${id}`,
  route: '/tarefas/:tenant/:id',
  live: { tenants, tasks },
});
test('lists every task, newest first, with stage and status', () => {
  renderWithLive(<Tasks />, { path: '/tarefas', route: '/tarefas', live: { tenants, tasks } });
  expect(listed()).toHaveLength(3);
  expect(listed()[0]).toContain('PF-1');
  expect(listed()[0]).toContain('Testes');
  expect(listed()[0]).toContain('Em andamento');
});
test('filters by company, project and status', async () => {
  const decisions = [{ id: 'd', tenantId: 'acme', taskId: 't2', status: 'open' } as DecisionView];
  renderWithLive(<Tasks />, {
    path: '/tarefas',
    route: '/tarefas',
    live: { tenants, tasks, decisions },
  });
  await userEvent.selectOptions(screen.getByLabelText('Empresa'), 'acme');
  expect(listed()).toHaveLength(2);
  await userEvent.selectOptions(screen.getByLabelText('Projeto'), 'api');
  expect(listed()).toHaveLength(1);
  expect(listed()[0]).toContain('Esperando você');
  await userEvent.selectOptions(screen.getByLabelText('Empresa'), '');
  await userEvent.click(screen.getByRole('button', { name: 'PR aberto' }));
  expect(listed()).toHaveLength(1);
  expect(listed()[0]).toContain('T-3');
});
test('the detail shows timeline, AI, runs, links and decisions; no commands', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(
    task({
      url: 'https://jira/PF-1',
      prUrl: 'https://pr/1',
      status: 'SUCCESS',
      stage: 'DONE',
      agentAttempts: [
        {
          credential: 'claude-max',
          provider: 'claude',
          role: 'coder',
          model: 'opus',
          outcome: 'success',
        },
      ],
      runs: [
        {
          agent: 'tester',
          provider: 'docker',
          status: 'SUCCESS',
          exitCode: 0,
          startedAt: '2026-10-06T10:00:00Z',
          finishedAt: '2026-10-06T10:00:30Z',
        },
      ],
      review: { final: 'approved', rounds: [{}] },
      checks: { findings: [], tools: {}, errors: [] },
      decisions: [
        {
          id: 'd9',
          type: 'question',
          status: 'answered',
          revisionId: null,
          createdAt: '2026-10-06T10:00:00Z',
        },
      ],
      revisions: [
        {
          id: 'r1',
          number: 1,
          instructions: 'troque o texto',
          origin: 'jira-comment',
          status: 'SUCCESS',
          stage: 'DONE',
          error: null,
          commitSha: 'abcdef1234',
          createdAt: '2026-10-06T11:00:00Z',
        },
      ],
    }),
  );
  renderWithLive(<Tasks />, detailAt('t1'));
  const detail = await screen.findByRole('article');
  expect(api.task).toHaveBeenCalledWith('acme', 't1');
  expect(within(detail).getByRole('link', { name: 'Card' })).toHaveAttribute(
    'href',
    'https://jira/PF-1',
  );
  expect(within(detail).getByRole('link', { name: 'Pull request' })).toHaveAttribute(
    'href',
    'https://pr/1',
  );
  expect(within(detail).getByText('ai/pf-1')).toBeInTheDocument();
  expect(within(detail).getByText(/Programador: claude-max \(opus\)/)).toBeInTheDocument();
  expect(within(detail).getByText(/tester · docker · SUCCESS · 30 s/)).toBeInTheDocument();
  expect(within(detail).getByText(/Aprovada/)).toBeInTheDocument();
  expect(within(detail).getByText(/#1 · jira-comment · SUCCESS · abcdef1/)).toBeInTheDocument();
  const phases = within(detail)
    .getAllByRole('listitem')
    .filter((li) => li.closest('.timeline'));
  expect(phases.length).toBeGreaterThan(0);
  expect(phases.every((li) => li.className === 'done')).toBe(true);
});
test('asking for a change sends the instructions and files', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(
    task({ status: 'SUCCESS', stage: 'DONE', prUrl: 'https://pr/1' }),
  );
  const revise = vi.spyOn(api, 'revise').mockResolvedValue({ revisionId: 'r2', number: 2 });
  renderWithLive(<Tasks />, detailAt('t1'));
  await screen.findByRole('article');
  const send = screen.getByRole('button', { name: 'Pedir ajuste' });
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByLabelText('O que ajustar'), 'mude a cor');
  await userEvent.upload(
    screen.getByLabelText('Anexos'),
    new File(['x'], 'print.png', { type: 'image/png' }),
  );
  await userEvent.click(send);
  const [tenant, id, form] = revise.mock.calls[0];
  expect([tenant, id]).toEqual(['acme', 't1']);
  expect(form.get('instructions')).toBe('mude a cor');
  expect((form.get('files') as File).name).toBe('print.png');
  expect(await screen.findByRole('status')).toHaveTextContent('Ajuste #2 pedido');
});
test('a refused change shows why', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(
    task({ status: 'SUCCESS', stage: 'DONE', prUrl: 'https://pr/1' }),
  );
  vi.spyOn(api, 'revise').mockRejectedValue(new ApiError(409, 'Já existe um ajuste em andamento'));
  renderWithLive(<Tasks />, detailAt('t1'));
  await screen.findByRole('article');
  await userEvent.type(screen.getByLabelText('O que ajustar'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Pedir ajuste' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Já existe um ajuste em andamento');
});
test('before the data arrives the list says it is loading (review finding 2)', () => {
  renderWithLive(<Tasks />, {
    path: '/tarefas',
    route: '/tarefas',
    live: { tenants, tasks: [], loaded: false },
  });
  expect(screen.getByText('Carregando…')).toBeInTheDocument();
  expect(screen.queryByText('Nenhuma tarefa.')).toBeNull();
});
test('the detail refreshes on any change of its task, e.g. a running revision (review finding 3)', async () => {
  const load = vi
    .spyOn(api, 'task')
    .mockResolvedValue(task({ status: 'SUCCESS', stage: 'DONE', prUrl: 'https://pr/1' }));
  const { emit } = renderWithLive(<Tasks />, detailAt('t1'));
  await screen.findByRole('article');
  expect(load).toHaveBeenCalledTimes(1);
  emit({ type: 'revision', id: 'r2', taskId: 't1', status: 'RUNNING', stage: 'TESTS' });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  emit({ type: 'task', id: 't2', taskId: 't2', tenantId: 'acme', status: 'RUNNING' });
  await new Promise((done) => setTimeout(done, 50));
  expect(load).toHaveBeenCalledTimes(2);
});
test('an unknown task says so', async () => {
  vi.spyOn(api, 'task').mockRejectedValue(new ApiError(404, 'Unknown task'));
  renderWithLive(<Tasks />, detailAt('nope'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Tarefa não encontrada');
});
