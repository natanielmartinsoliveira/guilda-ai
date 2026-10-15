import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api';
import { Login } from './Login';
afterEach(() => vi.restoreAllMocks());
test('password, then the Telegram code, then in', async () => {
  vi.spyOn(api, 'login').mockResolvedValue({ loginId: 'L1' });
  const verify = vi.spyOn(api, 'verify').mockResolvedValue({ ok: true });
  const onDone = vi.fn();
  render(<Login onDone={onDone} />);
  await userEvent.type(screen.getByLabelText('Senha'), 'minha-senha');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByText(/código de 6 dígitos no Telegram/)).toBeInTheDocument();
  const confirm = screen.getByRole('button', { name: 'Confirmar' });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Código'), '12a3456');
  expect(screen.getByLabelText('Código')).toHaveValue('123456');
  await userEvent.click(confirm);
  expect(verify).toHaveBeenCalledWith('L1', '123456');
  expect(onDone).toHaveBeenCalled();
});
test('a wrong password or a block shows the server message', async () => {
  vi.spyOn(api, 'login')
    .mockRejectedValueOnce(new ApiError(401, 'Senha ou código inválido'))
    .mockRejectedValueOnce(new ApiError(429, 'Muitas tentativas; tente de novo em 15 minutos'));
  render(<Login onDone={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Senha'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Senha ou código inválido');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas');
});
test('the button is disabled while the request runs (no double login)', async () => {
  let release!: (v: { loginId: string }) => void;
  const login = vi
    .spyOn(api, 'login')
    .mockReturnValue(new Promise((resolve) => (release = resolve)));
  render(<Login onDone={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Senha'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(login).toHaveBeenCalledTimes(1);
  release({ loginId: 'L1' });
});
