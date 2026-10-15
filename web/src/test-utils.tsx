import { act, render } from '@testing-library/react';
import { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';
import { Live, LiveContext } from './LiveProvider';
import type { ChangeEvent } from './types';
function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}
/**
 * Renders a screen with a given live state at `path`, matched by `route`. Any navigation to a
 * task detail lands on a probe that shows the path.
 */
export function renderWithLive(
  ui: ReactElement,
  {
    live = {},
    path = '/',
    route = '*',
  }: { live?: Partial<Live>; path?: string; route?: string } = {},
) {
  const listeners = new Set<(event: ChangeEvent) => void>();
  const value: Live = {
    tenants: [],
    tasks: [],
    decisions: [],
    connected: true,
    loaded: true,
    reload: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...live,
  };
  /** Delivers a change event as the stream would. */
  const emit = (event: ChangeEvent) => act(() => listeners.forEach((l) => l(event)));
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <LiveContext.Provider value={value}>
        <Routes>
          <Route path={route} element={ui} />
          {route !== '/tarefas/:tenant/:id' && (
            <Route path="/tarefas/:tenant/:id" element={<Where />} />
          )}
        </Routes>
      </LiveContext.Provider>
    </MemoryRouter>,
  );
  return { ...result, live: value, emit };
}
