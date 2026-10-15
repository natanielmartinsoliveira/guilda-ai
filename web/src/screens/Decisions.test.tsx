import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api';
import { renderWithLive } from '../test-utils';
import type { DecisionView } from '../types';
import { Decisions } from './Decisions';
afterEach(() => vi.restoreAllMocks());
const question: DecisionView = {
  id: 'd1',
  tenantId: 'acme',
  type: 'question',
  status: 'open',
  taskId: 't1',
  revisionId: null,
  card: 'PF-12',
  title: 'Filtro por data',
  questions: [{ text: 'Qual tela?', options: ['Lista', 'Detalhe'] }, { text: 'Qual formato?' }],
  reason: null,
  details: null,
  answer: null,
  createdAt: '2026-10-06T10:00:00Z',
  answeredAt: null,
};
const failure: DecisionView = {
  ...question,
  id: 'd2',
  type: 'failure',
  questions: null,
  reason: 'TESTS: Tests failed: boom',
  details: 'linha 1\nlinha 2',
};
const open = (path = '/decisoes', decisions = [question, failure]) =>
  renderWithLive(<Decisions />, {
    path,
    route: '/decisoes/:id?',
    live: {
      decisions,
      tenants: [{ id: 'acme', name: 'Acme', providers: [], jira: true, projects: [] }],
    },
  });
test('a question is only sent with every question answered', async () => {
  const answer = vi.spyOn(api, 'answer').mockResolvedValue(question);
  const { live } = open();
  const send = screen.getByRole('button', { name: 'Responder e continuar' });
  expect(send).toBeDisabled();
  await userEvent.click(screen.getByRole('radio', { name: 'Detalhe' }));
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Resposta 2'), 'dd/mm/aaaa');
  expect(send).toBeEnabled();
  await userEvent.click(send);
  expect(answer).toHaveBeenCalledWith('acme', 'd1', { answers: ['Detalhe', 'dd/mm/aaaa'] });
  expect(live.reload).toHaveBeenCalledWith(['acme']);
  expect(await screen.findByRole('status')).toHaveTextContent('Resposta enviada');
});
test('a free answer can replace the suggested options', async () => {
  const answer = vi.spyOn(api, 'answer').mockResolvedValue(question);
  open();
  await userEvent.type(screen.getByLabelText('Resposta 1'), 'As duas');
  await userEvent.type(screen.getByLabelText('Resposta 2'), 'ISO');
  await userEvent.click(screen.getByRole('button', { name: 'Responder e continuar' }));
  expect(answer).toHaveBeenCalledWith('acme', 'd1', { answers: ['As duas', 'ISO'] });
});
test('the draft survives leaving the page (session expired)', async () => {
  const first = open();
  await userEvent.type(screen.getByLabelText('Resposta 2'), 'rascunho');
  first.unmount();
  open();
  expect(screen.getByLabelText('Resposta 2')).toHaveValue('rascunho');
});
test('failure: retry, retry with instructions, cancel with confirmation', async () => {
  const answer = vi.spyOn(api, 'answer').mockResolvedValue(failure);
  open('/decisoes/d2');
  expect(screen.getByText('TESTS: Tests failed: boom')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Repetir' }));
  expect(answer).toHaveBeenLastCalledWith('acme', 'd2', { action: 'retry' });

  await userEvent.click(screen.getByRole('button', { name: 'Repetir com instrução' }));
  const send = screen.getByRole('button', { name: 'Enviar e repetir' });
  expect(send).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Instrução'), 'use a lib X');
  await userEvent.click(send);
  expect(answer).toHaveBeenLastCalledWith('acme', 'd2', {
    action: 'retry_with_instructions',
    instructions: 'use a lib X',
  });

  await userEvent.click(screen.getByRole('button', { name: 'Cancelar tarefa' }));
  expect(answer).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
  expect(answer).toHaveBeenLastCalledWith('acme', 'd2', { action: 'cancel' });
});
test('answered elsewhere (409): says so and reloads', async () => {
  vi.spyOn(api, 'answer').mockRejectedValue(new ApiError(409, 'Decision already answered'));
  const { live } = open('/decisoes/d2');
  await userEvent.click(screen.getByRole('button', { name: 'Repetir' }));
  expect(await screen.findByRole('status')).toHaveTextContent('já foi respondida');
  expect(live.reload).toHaveBeenCalledWith(['acme']);
});
test('other errors stay on the form with the message', async () => {
  vi.spyOn(api, 'answer').mockRejectedValue(new ApiError(502, 'Falha no servidor'));
  open('/decisoes/d2');
  await userEvent.click(screen.getByRole('button', { name: 'Repetir' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Falha no servidor');
});
test('a link to a decision that is no longer open says so', () => {
  open('/decisoes/velha');
  expect(screen.getByText(/não está mais aberta/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Ver as decisões abertas' })).toBeInTheDocument();
});
test('a Telegram link before the data arrives waits instead of saying it is closed (review finding 2)', () => {
  renderWithLive(<Decisions />, {
    path: '/decisoes/d1',
    route: '/decisoes/:id?',
    live: { decisions: [], loaded: false },
  });
  expect(screen.getByText('Carregando…')).toBeInTheDocument();
  expect(screen.queryByText(/não está mais aberta/)).toBeNull();
  expect(screen.queryByText('Nada esperando você.')).toBeNull();
});
test('nothing open', () => {
  open('/decisoes', []);
  expect(screen.getByText('Nada esperando você.')).toBeInTheDocument();
});
