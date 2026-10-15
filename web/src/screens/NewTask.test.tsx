import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api';
import { renderWithLive } from '../test-utils';
import type { Tenant } from '../types';
import { NewTask } from './NewTask';
beforeEach(() => {
  vi.spyOn(api, 'cardBases').mockResolvedValue({ subtask: false });
});
afterEach(() => vi.restoreAllMocks());
const JIRA = {
  id: 'jira',
  type: 'jira',
  label: 'Jira',
  key: 'jira' as const,
  example: 'PF-123',
  bases: true,
};
const BOARD = {
  id: 'businessmap',
  type: 'businessmap',
  label: 'Businessmap',
  key: 'number' as const,
  example: '48816',
  bases: false,
};
const tenants: Tenant[] = [
  {
    id: 'umbrella',
    name: 'Umbrella',
    providers: [],
    jira: false,
    sources: [],
    projects: [{ id: 'storefront', repository: 'n/storefront' }],
  },
  {
    id: 'initrode',
    name: 'Initrode',
    providers: [],
    jira: true,
    sources: [JIRA],
    projects: [
      { id: 'portal', repository: 't/eng' },
      { id: 'core', repository: 't/core' },
    ],
  },
];
const mount = () =>
  renderWithLive(<NewTask />, { path: '/nova', route: '/nova', live: { tenants } });
test('a source card: only companies with a card source; the key is normalized; opens the new task', async () => {
  const start = vi.spyOn(api, 'startCard').mockResolvedValue({ taskId: 'new-1' });
  const { live } = mount();
  const company = screen.getByLabelText('Empresa') as HTMLSelectElement;
  expect([...company.options].map((o) => o.value)).toEqual(['initrode']);
  const send = screen.getByRole('button', { name: 'Iniciar card' });
  await userEvent.type(screen.getByLabelText('Chave do card'), 'pf12');
  expect(send).toBeDisabled();
  await userEvent.clear(screen.getByLabelText('Chave do card'));
  await userEvent.type(screen.getByLabelText('Chave do card'), ' pf-12 ');
  await userEvent.click(send);
  expect(start).toHaveBeenCalledWith('initrode', 'jira', 'PF-12');
  expect(live.reload).toHaveBeenCalledWith(['initrode']);
  expect(await screen.findByTestId('where')).toHaveTextContent('/tarefas/initrode/new-1');
});
test('a card that is not started says why, with a link to the existing task', async () => {
  vi.spyOn(api, 'startCard').mockResolvedValue({
    skipped: 'Esse card já tem tarefa',
    taskId: 'old-1',
  });
  mount();
  await userEvent.type(screen.getByLabelText('Chave do card'), 'PF-12');
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar card' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Esse card já tem tarefa');
  expect(screen.getByRole('link', { name: 'Ver a tarefa' })).toHaveAttribute(
    'href',
    '/tarefas/initrode/old-1',
  );
});
test('a key without the dash shows the expected format; one with a space is accepted', async () => {
  const start = vi.spyOn(api, 'startCard').mockResolvedValue({ taskId: 'new-2' });
  mount();
  await userEvent.type(screen.getByLabelText('Chave do card'), 'pf12');
  expect(screen.getByText('Use o formato PF-123')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Iniciar card' })).toBeDisabled();
  await userEvent.clear(screen.getByLabelText('Chave do card'));
  await userEvent.type(screen.getByLabelText('Chave do card'), 'pf 12');
  expect(screen.queryByText('Use o formato PF-123')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar card' }));
  expect(start).toHaveBeenCalledWith('initrode', 'jira', 'PF-12');
});
test('Jira errors are shown', async () => {
  vi.spyOn(api, 'startCard').mockRejectedValue(new ApiError(502, 'Jira 404: Issue does not exist'));
  mount();
  await userEvent.type(screen.getByLabelText('Chave do card'), 'PF-99');
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar card' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Issue does not exist');
});
test('a free task: company, project, title, description and files', async () => {
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ taskId: 'free-1', key: 'T-1' });
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Livre' }));
  await userEvent.selectOptions(screen.getByLabelText('Empresa'), 'initrode');
  await userEvent.selectOptions(screen.getByLabelText('Projeto'), 'core');
  const send = screen.getByRole('button', { name: 'Criar tarefa' });
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Título'), 'Novo relatório');
  await userEvent.type(screen.getByLabelText('Descrição'), 'detalhes');
  await userEvent.upload(
    screen.getByLabelText('Anexos'),
    new File(['x'], 'tela.png', { type: 'image/png' }),
  );
  await userEvent.click(send);
  const [tenant, form] = create.mock.calls[0];
  expect(tenant).toBe('initrode');
  expect(form.get('project')).toBe('core');
  expect(form.get('title')).toBe('Novo relatório');
  expect(form.get('description')).toBe('detalhes');
  expect((form.get('files') as File).name).toBe('tela.png');
  expect(await screen.findByTestId('where')).toHaveTextContent('/tarefas/initrode/free-1');
});
test('a company with one project needs no project choice', async () => {
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ taskId: 'free-2', key: 'T-2' });
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Livre' }));
  await userEvent.selectOptions(screen.getByLabelText('Empresa'), 'umbrella');
  expect(screen.queryByLabelText('Projeto')).toBeNull();
  await userEvent.type(screen.getByLabelText('Título'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Criar tarefa' }));
  expect(create.mock.calls[0][1].get('project')).toBe('storefront');
});
const subtaskBases = (ownExists = false) => ({
  subtask: true as const,
  story: 'PF-23986',
  storyBranch: 'feature/PF-23986',
  ownBranch: 'feature/PF-24378',
  ownExists,
  bases: [
    { branch: 'feature/PF-23986', label: 'História PF-23986', date: '2026-10-05T10:00:00Z' },
    {
      branch: 'feature/PF-24377',
      label: 'PF-24377 — Botão Reprovar',
      date: '2026-10-06T19:21:00Z',
    },
  ],
});
test('a sub-task asks where to start from and sends the chosen branch', async () => {
  vi.mocked(api.cardBases).mockResolvedValue(subtaskBases());
  const start = vi.spyOn(api, 'startCard').mockResolvedValue({ taskId: 'new-3' });
  mount();
  await userEvent.type(screen.getByLabelText('Chave do card'), 'PF-24378');
  const base = await screen.findByLabelText('Começar a partir de');
  expect(api.cardBases).toHaveBeenCalledWith('initrode', 'jira', 'PF-24378');
  expect(screen.getByText(/O PR vai para feature\/PF-23986/)).toBeInTheDocument();
  const send = screen.getByRole('button', { name: 'Iniciar card' });
  expect(send).toBeDisabled();
  await userEvent.selectOptions(base, 'feature/PF-24377');
  await userEvent.click(send);
  expect(start).toHaveBeenCalledWith('initrode', 'jira', 'PF-24378', 'feature/PF-24377');
  expect(await screen.findByTestId('where')).toHaveTextContent('/tarefas/initrode/new-3');
});
test('a sub-task already begun says so and cannot be started', async () => {
  vi.mocked(api.cardBases).mockResolvedValue(subtaskBases(true));
  mount();
  await userEvent.type(screen.getByLabelText('Chave do card'), 'PF-24378');
  expect(await screen.findByText(/Já existe a branch feature\/PF-24378/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Iniciar card' })).toBeDisabled();
});
test('a project with a method asks for the route, and sends it', async () => {
  const create = vi.spyOn(api, 'createTask').mockResolvedValue({ taskId: 'rg-1', key: 'T-3' });
  renderWithLive(<NewTask />, {
    path: '/nova',
    route: '/nova',
    live: {
      tenants: [
        {
          id: 'initech',
          name: 'Initech',
          providers: [],
          jira: false,
          projects: [
            {
              id: 'orders',
              repository: 'shop/orders',
              method: 'review-gate',
              routes: [
                { id: 'feature', label: 'Funcionalidade nova (especificação → entrega)' },
                { id: 'screen', label: 'Tela já especificada (entrega)' },
                { id: 'fix', label: 'Correção de algo já entregue' },
                { id: 'adopt', label: 'Adotar código existente' },
                { id: 'cleanup', label: 'Remover comentários' },
                { id: 'direct', label: 'Edição direta' },
              ],
            },
            { id: 'front', repository: 'shop/front' },
          ],
        },
      ],
    },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Livre' }));
  await userEvent.selectOptions(screen.getByLabelText('Projeto'), 'front');
  expect(screen.queryByLabelText('Rota (review-gate)')).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('Projeto'), 'orders');
  await userEvent.type(screen.getByLabelText('Título'), 'Bloquear desconto');
  const send = screen.getByRole('button', { name: 'Criar tarefa' });
  expect(send).toBeDisabled();
  const routes = screen.getByLabelText('Rota (review-gate)') as HTMLSelectElement;
  expect([...routes.options].map((o) => o.value)).toEqual([
    '',
    'feature',
    'screen',
    'fix',
    'adopt',
    'cleanup',
    'direct',
  ]);
  await userEvent.selectOptions(screen.getByLabelText('Rota (review-gate)'), 'feature');
  await userEvent.click(send);
  expect(create.mock.calls[0][1].get('route')).toBe('feature');
});

test('a Businessmap card: numeric key, no sub-task bases; with two sources the operator picks one', async () => {
  const start = vi.spyOn(api, 'startCard').mockResolvedValue({ taskId: 'bm-1' });
  renderWithLive(<NewTask />, {
    path: '/nova',
    route: '/nova',
    live: {
      tenants: [
        {
          id: 'initech',
          name: 'Initech',
          providers: [],
          jira: false,
          sources: [BOARD, JIRA],
          projects: [],
        },
      ],
    },
  });
  const source = screen.getByLabelText('Origem') as HTMLSelectElement;
  expect([...source.options].map((o) => o.textContent)).toEqual(['Businessmap', 'Jira']);
  const key = screen.getByLabelText('Chave do card') as HTMLInputElement;
  expect(key.placeholder).toBe('48816');
  await userEvent.selectOptions(source, 'jira');
  expect(key.placeholder).toBe('PF-123');
  await userEvent.selectOptions(source, 'businessmap');
  await userEvent.type(key, 'card');
  expect(screen.getByText('Use o formato 48816')).toBeInTheDocument();
  await userEvent.clear(key);
  await userEvent.type(key, ' #48816 ');
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar card' }));
  expect(start).toHaveBeenCalledWith('initech', 'businessmap', '48816');
  expect(api.cardBases).not.toHaveBeenCalled();
});
test('no company with a card source says so', () => {
  renderWithLive(<NewTask />, {
    path: '/nova',
    route: '/nova',
    live: { tenants: [tenants[0]] },
  });
  expect(screen.getByText('Nenhuma empresa tem origem de cards configurada.')).toBeInTheDocument();
});
