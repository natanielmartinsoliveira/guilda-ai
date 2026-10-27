import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../api';
import { renderWithLive } from '../test-utils';
import type { TaskView } from '../types';
import { TaskDetail } from './TaskDetail';
afterEach(() => vi.restoreAllMocks());
const rehearsed = (discarded = false): TaskView => ({
  id: 't1',
  tenantId: 'initech',
  project: 'svc',
  branch: '49145-fix-billing',
  key: '49145',
  title: 'Fix billing',
  status: 'SUCCESS',
  stage: 'REHEARSED',
  provider: 'claude',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  rehearsal: {
    workspace: 'ws:/root/ai/t1',
    branch: '49145-fix-billing',
    commitSha: 'abcdef1234567',
    files: ['src/a.ts', 'src/b.ts'],
    ...(discarded ? { discarded: true } : {}),
  },
  createdAt: '2026-10-10T10:00:00Z',
  updatedAt: '2026-10-10T10:00:00Z',
});
const show = () =>
  renderWithLive(<TaskDetail tenant="initech" id="t1" />, { path: '/', route: '/' });
test('a rehearsal says nothing was published and where to look', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(rehearsed());
  show();
  expect(await screen.findByText(/Ensaio concluído — nada foi publicado/)).toBeTruthy();
  expect(screen.getByText('ws:/root/ai/t1')).toBeTruthy();
  expect(screen.getByText('src/b.ts')).toBeTruthy();
  expect(screen.getByText('abcdef1')).toBeTruthy();
});
test('discarding calls the API and reloads', async () => {
  const task = vi
    .spyOn(api, 'task')
    .mockResolvedValueOnce(rehearsed())
    .mockResolvedValue(rehearsed(true));
  const discard = vi.spyOn(api, 'discard').mockResolvedValue({ discarded: true });
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Descartar ensaio' }));
  expect(discard).toHaveBeenCalledWith('initech', 't1');
  expect(await screen.findByText('Pasta descartada.')).toBeTruthy();
  expect(task).toHaveBeenCalledTimes(2);
});
test('a rehearsal can be published as a draft PR; once promoted it is no longer a rehearsal', async () => {
  const promoted: TaskView = {
    ...rehearsed(),
    stage: 'DONE',
    rehearsal: { ...rehearsed().rehearsal!, promoted: true },
  };
  const task = vi.spyOn(api, 'task').mockResolvedValueOnce(rehearsed()).mockResolvedValue(promoted);
  const promote = vi.spyOn(api, 'promote').mockResolvedValue({});
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Abrir MR rascunho' }));
  expect(promote).toHaveBeenCalledWith('initech', 't1');
  await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/nada foi publicado/)).toBeNull();
});
test('a discarded rehearsal cannot be published', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(rehearsed(true));
  show();
  expect(await screen.findByText('Pasta descartada.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Abrir MR rascunho' })).toBeNull();
});
test('a rehearsal can be adjusted until it is discarded', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(rehearsed());
  const first = show();
  expect(await screen.findByRole('heading', { name: 'Pedir ajuste' })).toBeTruthy();
  first.unmount();
  vi.spyOn(api, 'task').mockResolvedValue(rehearsed(true));
  show();
  await screen.findByText('Pasta descartada.');
  expect(screen.queryByRole('heading', { name: 'Pedir ajuste' })).toBeNull();
});
const withEvidence = (): TaskView => ({
  ...rehearsed(),
  evidence: {
    shots: [
      {
        file: '01-tela.png',
        title: 'Contrato com o nome do plano',
        url: 'http://localhost:3000/c',
        at: '14/10/2026 17:25:03 (America/Sao_Paulo)',
      },
    ],
    comment: 'Teste desenvolvedor:\nExecução: ( ) Manual   (x) Automática',
    trace: true,
  },
});
test('test evidence: each print with title, URL and time; the comment can be copied', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(withEvidence());
  const file = vi.spyOn(api, 'evidenceFile').mockResolvedValue(new Blob(['png']));
  const objectUrl = vi.fn(() => 'blob:print-1');
  Object.assign(URL, { createObjectURL: objectUrl, revokeObjectURL: vi.fn() });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  show();
  expect(await screen.findByRole('heading', { name: 'Evidência de teste' })).toBeTruthy();
  expect(screen.getByText('Contrato com o nome do plano')).toBeTruthy();
  expect(screen.getByText(/http:\/\/localhost:3000\/c/)).toBeTruthy();
  expect(screen.getByText(/14\/10\/2026 17:25:03/)).toBeTruthy();
  const img = (await screen.findByRole('img', {
    name: 'Contrato com o nome do plano',
  })) as HTMLImageElement;
  expect(img.src).toBe('blob:print-1');
  expect(file).toHaveBeenCalledWith('initech', 't1', '01-tela.png');
  await userEvent.click(screen.getByRole('button', { name: 'Copiar comentário' }));
  expect(writeText).toHaveBeenCalledWith(
    'Teste desenvolvedor:\nExecução: ( ) Manual   (x) Automática',
  );
  expect(await screen.findByText('Comentário copiado: cole no card.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Baixar trace' })).toBeTruthy();
});
test('no evidence block when the task has none', async () => {
  vi.spyOn(api, 'task').mockResolvedValue(rehearsed());
  show();
  await screen.findByText(/Ensaio concluído — nada foi publicado/);
  expect(screen.queryByRole('heading', { name: 'Evidência de teste' })).toBeNull();
});
test('the AI used shows the models each run really used', async () => {
  vi.spyOn(api, 'task').mockResolvedValue({
    ...rehearsed(),
    agentAttempts: [
      {
        credential: 'company-claude',
        provider: 'claude',
        role: 'coder',
        outcome: 'success',
        usedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      },
    ],
  });
  show();
  expect(await screen.findByText(/claude-opus-5-5, claude-sonnet-5-5/)).toBeTruthy();
});
test('the AI used shows what each run cost and the task total', async () => {
  vi.spyOn(api, 'task').mockResolvedValue({
    ...rehearsed(),
    costUsd: 1.75,
    agentAttempts: [
      {
        credential: 'company-claude',
        provider: 'claude',
        role: 'coder',
        outcome: 'success',
        costUsd: 1.25,
      },
      {
        credential: 'company-claude',
        provider: 'claude',
        role: 'coder',
        outcome: 'quota',
        costUsd: 0.5,
      },
    ],
  });
  show();
  expect(await screen.findByText(/US\$ 1\.75/)).toBeTruthy();
  expect(screen.getByText(/US\$ 1\.25/)).toBeTruthy();
});
test('metrics: where the time went, the tokens per model and per method phase', async () => {
  const usage = { input: 1200, output: 300, cacheCreation: 50, cacheRead: 9000, turns: 14 };
  vi.spyOn(api, 'task').mockResolvedValue({
    ...rehearsed(),
    usage: { ...usage, byModel: { 'claude-opus-5-5': { ...usage, costUsd: 0.4 } } },
    metrics: {
      totalMs: 3 * 3600000,
      agentMs: 90 * 60000,
      waitingMs: 60 * 60000,
      otherMs: 30 * 60000,
      waits: { questions: 2, failures: 1 },
      phases: { deliver: { runs: 2, agentMs: 75 * 60000, usage } },
    },
    methodTelemetry: {
      agents: {
        'task-implementer': { ...usage, runs: 3, measured: 2, durationMs: 20 * 60000 },
      },
      reports: [],
    },
    runs: [
      {
        agent: 'coder',
        provider: 'claude',
        status: 'SUCCESS',
        exitCode: 0,
        phase: 'deliver',
        usage,
        startedAt: '2026-10-10T10:00:00Z',
        finishedAt: '2026-10-10T10:30:00Z',
      },
    ],
  });
  show();
  expect(
    await screen.findByText(
      'Tempo total 3 h 0 min · IA 1 h 30 min · esperando você 1 h 0 min · fila, testes e git 30 min',
    ),
  ).toBeTruthy();
  expect(screen.getByText('2 pergunta(s) e 1 falha(s) esperaram você')).toBeTruthy();
  expect(screen.getByText(/^claude-opus-5-5: Tokens: entrada 1.200/)).toBeTruthy();
  expect(screen.getByText(/US\$ 0\.40/)).toBeTruthy();
  expect(screen.getByText(/^Fase deliver: 2 execução\(ões\), 1 h 15 min · Tokens/)).toBeTruthy();
  expect(screen.getByText(/coder \(deliver\) · claude · SUCCESS · 30 min/)).toBeTruthy();
  expect(
    screen.getByText(
      /^task-implementer: 3 execução\(ões\), 20 min \(só 2 medida\(s\): é um piso\)/,
    ),
  ).toBeTruthy();
});
