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
