import { MemoryRouter } from 'react-router';
import { LiveContext } from '../LiveProvider';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api';
import type { CameraMode } from '../office/camera';
import type { OfficeSelection } from '../office/game';
import type { OfficeModel } from '../office/spots';
import { renderWithLive } from '../test-utils';
import type { DecisionView, TaskView, Tenant } from '../types';
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
  type FakeView = {
    update: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setCameraMode: ReturnType<typeof vi.fn>;
    zoomBy: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    focusRoom: ReturnType<typeof vi.fn>;
    onCameraModeChange: ReturnType<typeof vi.fn>;
  };
  const views: FakeView[] = [];
  let reportMode: (mode: CameraMode) => void = () => undefined;
  let select: (selection: OfficeSelection) => void = () => undefined;
  const createOffice = vi.fn(
    (_parent: HTMLElement, onSelect: (selection: OfficeSelection) => void) => {
      select = onSelect;
      const view = {
        update: vi.fn(),
        destroy: vi.fn(),
        setCameraMode: vi.fn(),
        zoomBy: vi.fn(),
        focus: vi.fn(),
        focusRoom: vi.fn(),
        onCameraModeChange: vi.fn((cb: (mode: CameraMode) => void) => {
          reportMode = cb;
        }),
      };
      views.push(view);
      return view;
    },
  );
  return {
    loadGame: vi.fn(async () => ({ createOffice })),
    createOffice,
    views,
    reportMode: (mode: CameraMode) => act(() => reportMode(mode)),
    select: (id: string, tenantId = 'acme') => act(() => select({ tenantId, id })),
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
  await userEvent.click(screen.getByRole('button', { name: /Globex/ }));
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
const decision = (id: string, tenantId: string, createdAt: string, text: string): DecisionView => ({
  id,
  tenantId,
  type: 'question',
  status: 'open',
  taskId: 'a1',
  revisionId: null,
  card: '49560',
  title: 'Débito Técnico: testes do Voice',
  questions: [{ text }],
  reason: null,
  details: null,
  answer: null,
  createdAt,
  answeredAt: null,
});
const withDecisions = (game: ReturnType<typeof fakeGame>, decisions: DecisionView[]) =>
  renderWithLive(<Office loadGame={game.loadGame} />, {
    path: '/escritorio',
    route: '/escritorio',
    live: { tenants, tasks, decisions },
  });
test('an open decision pops a game-like request over the map, linking to its screen', async () => {
  withDecisions(fakeGame(), [
    decision('d1', 'globex', '2026-10-15T10:00:00Z', 'Portão — especificação pronta\nArquivos…'),
  ]);
  const popup = await screen.findByRole('dialog', { name: 'Pedido de decisão' });
  expect(popup).toHaveTextContent('Globex · 49560');
  expect(popup).toHaveTextContent('Portão — especificação pronta');
  expect(popup).not.toHaveTextContent('Arquivos');
  expect(screen.getByRole('link', { name: 'Responder' })).toHaveAttribute('href', '/decisoes/d1');
});
test('the newest one shows with how many more wait; "Later" hides only that one', async () => {
  withDecisions(fakeGame(), [
    decision('old', 'acme', '2026-10-15T09:00:00Z', 'Primeira'),
    decision('new', 'acme', '2026-10-15T10:00:00Z', 'Segunda'),
  ]);
  const popup = await screen.findByRole('dialog', { name: 'Pedido de decisão' });
  expect(popup).toHaveTextContent('Segunda');
  expect(popup).toHaveTextContent('+1 aguardando');
  await userEvent.click(screen.getByRole('button', { name: 'Depois' }));
  expect(screen.getByRole('dialog', { name: 'Pedido de decisão' })).toHaveTextContent('Primeira');
  await userEvent.click(screen.getByRole('button', { name: 'Depois' }));
  expect(screen.queryByRole('dialog', { name: 'Pedido de decisão' })).toBeNull();
});
test('no open decision, or the demo, shows no request', async () => {
  const game = fakeGame();
  withDecisions(game, [
    { ...decision('d1', 'acme', '2026-10-15T10:00:00Z', 'x'), status: 'answered' },
  ]);
  await waitFor(() => expect(game.loadGame).toHaveBeenCalled());
  expect(screen.queryByRole('dialog', { name: 'Pedido de decisão' })).toBeNull();
});

test('other company running counts remain visible in room tabs', async () => {
  mount(fakeGame());
  expect(screen.getByRole('button', { name: 'Globex, 1 em execução' })).toHaveTextContent(
    'Globex ◆ 1',
  );
});
test('camera controls call the game and track manual mode changes', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: 'Visão geral' }));
  expect(game.views[0].setCameraMode).toHaveBeenCalledWith('overview');
  expect(screen.getByRole('button', { name: 'Visão geral' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Aproximar' }));
  expect(game.views[0].zoomBy).toHaveBeenCalledWith(1.2);
  await userEvent.click(screen.getByRole('button', { name: 'Afastar' }));
  expect(game.views[0].zoomBy).toHaveBeenCalledWith(1 / 1.2);
  game.reportMode('manual');
  expect(screen.getByRole('button', { name: 'Acompanhar' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Acompanhar' }));
  expect(game.views[0].setCameraMode).toHaveBeenLastCalledWith('follow');
  game.reportMode('manual');
  game.views[0].setCameraMode.mockClear();
  await userEvent.click(screen.getByRole('button', { name: /Globex/ }));
  expect(game.views[0].setCameraMode.mock.calls).toEqual([['follow']]);
  expect(screen.getByRole('button', { name: 'Acompanhar' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
test('parallel station keys focus their own member and open real task details', async () => {
  const game = fakeGame();
  const second = task('a2', 'acme', 'PF-2');
  vi.spyOn(api, 'task').mockResolvedValue(second);
  renderWithLive(<Office loadGame={game.loadGame} />, {
    path: '/escritorio',
    route: '/escritorio',
    live: { tenants, tasks: [tasks[0], second] },
  });
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  const station = screen.getByRole('group', { name: 'Programador' });
  expect(within(station).getByRole('button', { name: 'PF-1' })).toBeInTheDocument();
  await userEvent.click(within(station).getByRole('button', { name: 'PF-2' }));
  expect(game.views[0].focus).toHaveBeenCalledWith('a2', 'acme');
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(api.task).toHaveBeenCalledWith('acme', 'a2');
});

const allRooms = () => screen.getByRole('button', { name: /^Todas as empresas/ });
test('all companies is optional, not selected by default and hidden for one company', async () => {
  const game = fakeGame();
  const result = mount(game);
  expect(allRooms()).toHaveAttribute('aria-pressed', 'false');
  result.unmount();
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: { tenants: [tenants[0]], tasks: [tasks[0]] },
  });
  expect(screen.queryByRole('button', { name: /Todas as empresas/ })).toBeNull();
});
test('all companies sends isolated rooms, updates the eyebrow and exits when demo starts', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  expect(game.lastModel().rooms?.map((r) => r.tenantId)).toEqual(['acme', 'globex']);
  expect(game.lastModel().rooms![0].model.crew.map((m) => m.taskId)).toEqual(['a1']);
  expect(document.querySelector('.eyebrow')).toHaveTextContent('Todas as empresas');
  expect(allRooms()).toHaveTextContent('◆ 2');
  await userEvent.click(screen.getByRole('button', { name: 'Demonstração' }));
  expect(allRooms()).toHaveAttribute('aria-pressed', 'false');
  expect(game.lastModel().rooms).toBeUndefined();
});
test('campus canvas selections fetch the task from its own company and open room resets follow', async () => {
  const game = fakeGame();
  vi.spyOn(api, 'task').mockResolvedValue(tasks[1]);
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  game.select('g1', 'globex');
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(api.task).toHaveBeenCalledWith('globex', 'g1');
  const panel = screen.getByRole('complementary', { name: 'Painel da guilda' });
  expect(within(panel).getByLabelText('Empresa: Globex')).toBeInTheDocument();
  game.select('@coder', 'globex');
  game.reportMode('manual');
  game.views[0].setCameraMode.mockClear();
  await userEvent.click(screen.getByRole('button', { name: 'Abrir sala' }));
  expect(allRooms()).toHaveAttribute('aria-pressed', 'false');
  expect(game.lastModel().roomKey).toBe('globex');
  expect(game.views[0].setCameraMode.mock.calls).toEqual([['follow']]);
  expect(screen.getByRole('button', { name: 'Acompanhar' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
test('campus cards group keys by company, preserve urgent tones and fetch the correct task', async () => {
  const game = fakeGame();
  vi.spyOn(api, 'task').mockResolvedValue(tasks[1]);
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  const coder = screen.getByRole('group', { name: 'Programador' });
  expect(within(coder).getByLabelText('Empresa: Acme')).toBeInTheDocument();
  expect(within(coder).getByLabelText('Empresa: Globex')).toBeInTheDocument();
  await userEvent.click(within(coder).getByRole('button', { name: 'T-9' }));
  expect(game.views[0].focus).toHaveBeenCalledWith('g1', 'globex');
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(api.task).toHaveBeenCalledWith('globex', 'g1');
});
test('campus areas show decisions and pending tasks with both company chips', async () => {
  const game = fakeGame();
  const pending = tasks.map((t) => ({ ...t, status: 'PENDING' as const, stage: 'QUEUED' }));
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: {
      tenants,
      tasks: pending,
      decisions: [
        decision('a', 'acme', '2026-10-18T12:00:00Z', 'A'),
        decision('g', 'globex', '2026-10-18T12:01:00Z', 'G'),
      ],
    },
  });
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  await userEvent.click(screen.getByRole('button', { name: /Esperando você/ }));
  const panel = screen.getByRole('complementary', { name: 'Painel da guilda' });
  expect(within(panel).getByLabelText('Empresa: Acme')).toBeInTheDocument();
  expect(within(panel).getByLabelText('Empresa: Globex')).toBeInTheDocument();
  expect(within(panel).getAllByRole('link')).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: /Fila de tarefas/ }));
  expect(within(panel).getByLabelText('Empresa: Acme')).toBeInTheDocument();
  expect(within(panel).getByLabelText('Empresa: Globex')).toBeInTheDocument();
});

test('campus seats grow independently, remain during updates and reset after leaving the campus', async () => {
  const game = fakeGame();
  const live = {
    tenants,
    tasks,
    decisions: [],
    loaded: true,
    connected: true,
    reload: vi.fn(async () => {}),
    subscribe: () => () => {},
  };
  const ui = (current: typeof live) => (
    <MemoryRouter>
      <LiveContext.Provider value={current}>
        <Office loadGame={game.loadGame} />
      </LiveContext.Provider>
    </MemoryRouter>
  );
  const result = render(ui(live));
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  const crowded = [...tasks, task('a2', 'acme', 'PF-2'), task('a3', 'acme', 'PF-3')];
  result.rerender(ui({ ...live, tasks: crowded }));
  await waitFor(() => expect(game.lastModel().rooms?.map((r) => r.seats)).toEqual([3, 1]));
  result.rerender(ui(live));
  expect(game.lastModel().rooms?.map((r) => r.seats)).toEqual([3, 1]);
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Sala' })).getByRole('button', { name: /Acme/ }),
  );
  await userEvent.click(allRooms());
  expect(game.lastModel().rooms?.map((r) => r.seats)).toEqual([1, 1]);
  result.unmount();
  mount(fakeGame());
  expect(allRooms()).toHaveAttribute('aria-pressed', 'false');
});
test('accessible company signs focus a room without changing the selected campus', async () => {
  const game = fakeGame();
  mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  game.views[0].focusRoom.mockClear();
  await userEvent.click(
    screen.getByRole('button', { name: 'Enquadrar sala Globex, 1 em execução' }),
  );
  expect(game.views[0].focusRoom.mock.calls).toEqual([['globex']]);
  expect(screen.getByRole('button', { name: 'Acompanhar' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(allRooms()).toHaveAttribute('aria-pressed', 'true');
});

test('campus keys scope camera focus and detail requests when task ids collide', async () => {
  const game = fakeGame();
  const duplicate = task('a1', 'globex', 'T-9');
  vi.spyOn(api, 'task').mockResolvedValue(duplicate);
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: { tenants, tasks: [tasks[0], duplicate] },
  });
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Programador' })).getByRole('button', { name: 'T-9' }),
  );
  expect(game.views[0].focus.mock.calls).toEqual([['a1', 'globex']]);
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(api.task).toHaveBeenCalledWith('globex', 'a1');
});

test('company theme defaults to guild and is sent to the game when configured', async () => {
  const game = fakeGame();
  const result = mount(game);
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  expect(game.lastModel().theme).toBe('guild');
  expect(screen.queryByRole('combobox', { name: 'Tema' })).toBeNull();
  result.unmount();
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: { tenants: [{ ...tenants[0], officeTheme: 'studio' }], tasks: [tasks[0]] },
  });
  await waitFor(() => expect(game.views).toHaveLength(2));
  expect(game.lastModel().theme).toBe('studio');
});
test('demo previews themes without changing the company configuration', async () => {
  const game = fakeGame();
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: { tenants: [{ ...tenants[0], officeTheme: 'studio' }], tasks: [tasks[0]] },
  });
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  const demo = screen.getByRole('button', { name: 'Demonstração' });
  await userEvent.click(demo);
  const select = screen.getByRole('combobox', { name: 'Tema' });
  expect(select).toHaveValue('studio');
  for (const theme of ['pipeline', 'guild', 'studio', 'pipeline']) {
    await userEvent.selectOptions(select, theme);
    expect(game.lastModel().theme).toBe(theme);
  }
  await userEvent.click(demo);
  expect(screen.queryByRole('combobox', { name: 'Tema' })).toBeNull();
  expect(game.lastModel().theme).toBe('studio');
  await userEvent.click(demo);
  expect(screen.getByRole('combobox', { name: 'Tema' })).toHaveValue('studio');
});
test('campus passes the configured theme of each company', async () => {
  const game = fakeGame();
  renderWithLive(<Office loadGame={game.loadGame} />, {
    live: {
      tenants: [
        { ...tenants[0], officeTheme: 'studio' },
        { ...tenants[1], officeTheme: 'pipeline' },
      ],
      tasks,
    },
  });
  await waitFor(() => expect(game.createOffice).toHaveBeenCalled());
  await userEvent.click(allRooms());
  expect(game.lastModel().rooms?.map((r) => [r.tenantId, r.theme, r.model.theme])).toEqual([
    ['acme', 'studio', 'studio'],
    ['globex', 'pipeline', 'pipeline'],
  ]);
});
