import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from './api';
import { App } from './App';
beforeEach(() => {
  vi.stubGlobal(
    'EventSource',
    class {
      onerror = null;
      addEventListener() {}
      close() {}
    },
  );
  vi.spyOn(api, 'tenants').mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('without a session it shows the login', async () => {
  vi.spyOn(api, 'me').mockResolvedValue({ authenticated: false });
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('Senha')).toBeInTheDocument();
});
test('with a session it shows the tabs and opens Decisões', async () => {
  vi.spyOn(api, 'me').mockResolvedValue({ authenticated: true });
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: /Decisões/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Tarefas/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Nova/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Escritório/ })).toHaveClass('desktop-only');
  expect(await screen.findByRole('heading', { name: 'Decisões' })).toBeInTheDocument();
});
test('a 401 from the API while using the app goes back to the login', async () => {
  vi.spyOn(api, 'me').mockResolvedValue({ authenticated: true });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
  );
  vi.mocked(api.tenants).mockRestore();
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('Senha')).toBeInTheDocument();
});
