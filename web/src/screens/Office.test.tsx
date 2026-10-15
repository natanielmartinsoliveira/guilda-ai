import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api';
import type { OfficeModel } from '../office/spots';
import { renderWithLive } from '../test-utils';
import type { TaskView, Tenant } from '../types';
import { Office } from './Office';
const tenants: Tenant[] = [
  { id: 'acme', name: 'Acme', providers: [], jira: true, projects: [] },
  { id: 'globex', name: 'Globex', providers: [], jira: false, projects: [] },
];
const task = (id: string, tenantId: string, key: string): TaskView => ({
  id,
  tenantId,
  branch: '',
  key,
  title: key,
  status: 'RUNNING',
  stage: 'AGENT',
  provider: 'claude',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: '2026-10-06T10:00:00Z',
  updatedAt: '2026-10-06T10:00:00Z',
});
const tasks = [task('a1', 'acme', 'PF-1'), task('g1', 'globex', 'T-9')];
function wide(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}
function fakeGame() {
  const views: { update: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  let select: (taskId: string) => void = () => undefined;
  const createOffice = vi.fn((_parent: HTMLElement, onSelect: (taskId: string) => void) => {
    select = onSelect;
    const view = { update: vi.fn(), destroy: vi.fn() };
    views.push(view);
    return view;
  });
  return {
    loadGame: vi.fn(async () => ({ createOffice })),
    createOffice,
    views,
    select: (id: string) => act(() => select(id)),
    lastModel: () => {
      const update = views[views.length - 1].update;
      return update.mock.calls[update.mock.calls.length - 1][0] as OfficeModel;
    },
  };
}
beforeEach(() => wide(true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = (game: ReturnType<typeof fakeGame>) =>
  renderWithLive(<Office loadGame={game.loadGame} />, {
    path: '/escritorio',
    route: '/escritorio',
    live: { tenants, tasks },
  });
test('on a phone it loads an explorable map and accessible station controls', async () => {
  wide(false);
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.loadGame).toHaveBeenCalled());
  expect(screen.getByRole('region', { name: /Mapa da guilda/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Programador/ })).toBeInTheDocument();
});
test('one room per company: the scene gets only that company tasks', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalledTimes(1));
  expect(game.createOffice.mock.calls[0][0]).toBe(screen.getByTestId('office-canvas'));
  await waitFor(() => expect(game.lastModel().folders.map((f) => f.key)).toEqual(['PF-1']));
  await userEvent.click(screen.getByRole('button', { name: 'Globex' }));
  await waitFor(() => expect(game.lastModel().folders.map((f) => f.key)).toEqual(['T-9']));
});
test('clicking a folder opens the task beside the room', async () => {
  vi.spyOn(api, 'task').mockResolvedValue({ ...tasks[0], prUrl: undefined });
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  game.select('a1');
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(api.task).toHaveBeenCalledWith('acme', 'a1');
  await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
  expect(screen.queryByRole('article')).toBeNull();
});
test('the demo walks fake folders and clicking them opens nothing (focus 5)', async () => {
  const load = vi.spyOn(api, 'task');
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: 'Demonstração' }));
  await waitFor(() =>
    expect(game.lastModel().folders.every((f) => f.key.startsWith('DEMO-'))).toBe(true),
  );
  game.select('demo-1');
  expect(screen.queryByRole('article')).toBeNull();
  expect(load).not.toHaveBeenCalled();
});
test('leaving the tab destroys the scene (focus 3)', async () => {
  const game = fakeGame();
  const { unmount } = mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  unmount();
  expect(game.views[0].destroy).toHaveBeenCalled();
});
test('a failed download of the office says so (review finding 3)', async () => {
  renderWithLive(<Office loadGame={() => Promise.reject(new Error('chunk 404'))} />, {
    path: '/escritorio',
    route: '/escritorio',
    live: { tenants, tasks },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Não foi possível carregar o escritório',
  );
});

test('a station exposes real missions and an honest empty progress state', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: /Programador/ }));
  expect(screen.getByRole('heading', { name: 'Programador' })).toBeInTheDocument();
  expect(screen.getByText('Progresso percentual não informado pelo sistema.')).toBeInTheDocument();
  expect(screen.getByText(/Última atividade: Programando/)).toBeInTheDocument();
});
test('map area clicks open accessible lists with clear empty states', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  game.select('@waiting');
  expect(screen.getByText('Nenhuma decisão pendente nesta sala.')).toBeInTheDocument();
  game.select('@delivery');
  expect(screen.getByText('Nenhuma entrega concluída disponível.')).toBeInTheDocument();
  game.select('@queue');
  expect(screen.getByText('Nenhuma tarefa pendente.')).toBeInTheDocument();
});
test('demo station panels keep real missions instead of fetching simulated ids', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: 'Demonstração' }));
  game.select('@coder');
  const panel = screen.getByRole('complementary', { name: 'Painel da guilda' });
  expect(panel).toHaveTextContent('PF-1');
  expect(panel).not.toHaveTextContent('DEMO-');
});
