import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from './api';
import { LiveProvider, SourceLike, useLive } from './LiveProvider';
import type { ChangeEvent, DecisionView, TaskView } from './types';
class FakeSource implements SourceLike {
  static all: FakeSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  private listener?: (event: { data: string }) => void;
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(_type: 'change', listener: (event: { data: string }) => void) {
    this.listener = listener;
  }
  close() {
    this.closed = true;
  }
  emit(data: object) {
    this.listener?.({ data: JSON.stringify(data) });
  }
}
const connect = (url: string) => new FakeSource(url);
const last = () => FakeSource.all[FakeSource.all.length - 1];
const heard: ChangeEvent[] = [];
let current: ReturnType<typeof useLive>;
function Probe() {
  const live = useLive();
  current = live;
  useEffect(() => live.subscribe((event) => heard.push(event)), [live]);
  return (
    <pre data-testid="state">
      {JSON.stringify({
        tasks: live.tasks.map((t) => t.id).sort(),
        decisions: live.decisions.map((d) => d.id),
        connected: live.connected,
        loaded: live.loaded,
      })}
    </pre>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}');
const t = (id: string, tenantId: string) => ({ id, tenantId }) as TaskView;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
beforeEach(() => {
  FakeSource.all = [];
  heard.length = 0;
  vi.spyOn(api, 'tenants').mockResolvedValue([
    { id: 'acme', name: 'Acme', providers: [], jira: true, projects: [] },
    { id: 'globex', name: 'Globex', providers: [], jira: false, projects: [] },
  ]);
  vi.spyOn(api, 'tasks').mockImplementation(async (tenant) => [t(`${tenant}-1`, tenant)]);
  vi.spyOn(api, 'decisions').mockImplementation(async (tenant) =>
    tenant === 'acme' ? [{ id: 'd1', tenantId: 'acme', status: 'open' } as DecisionView] : [],
  );
});
afterEach(() => vi.restoreAllMocks());
function mount(retryMs = 10) {
  render(
    <LiveProvider connect={connect} retryMs={retryMs} debounceMs={5}>
      <Probe />
    </LiveProvider>,
  );
}
test('loads every tenant and opens the event stream; connected once it really opens', async () => {
  mount();
  expect(state().loaded).toBe(false);
  await waitFor(() => expect(state().tasks).toEqual(['acme-1', 'globex-1']));
  expect(state().loaded).toBe(true);
  expect(state().decisions).toEqual(['d1']);
  expect(FakeSource.all).toHaveLength(1);
  expect(FakeSource.all[0].url).toBe('/api/events');
  expect(state().connected).toBe(false);
  act(() => FakeSource.all[0].onopen?.());
  expect(state().connected).toBe(true);
});
test('a change reloads only the tenant it belongs to, and reaches subscribers', async () => {
  mount();
  await waitFor(() => expect(state().tasks).toHaveLength(2));
  vi.mocked(api.tasks).mockClear();
  const event = { type: 'decision', id: 'd2', taskId: 'x', tenantId: 'globex', status: 'open' };
  act(() => FakeSource.all[0].emit(event));
  await waitFor(() => expect(api.tasks).toHaveBeenCalledTimes(1));
  expect(api.tasks).toHaveBeenCalledWith('globex');
  expect(heard).toEqual([event]);
});
test('a revision event finds its tenant through the task', async () => {
  mount();
  await waitFor(() => expect(state().tasks).toHaveLength(2));
  vi.mocked(api.tasks).mockClear();
  act(() =>
    FakeSource.all[0].emit({ type: 'revision', id: 'r1', taskId: 'acme-1', status: 'RUNNING' }),
  );
  await waitFor(() => expect(api.tasks).toHaveBeenCalledWith('acme'));
  expect(api.tasks).toHaveBeenCalledTimes(1);
});
test('a dropped stream reconnects after a pause and reloads everything', async () => {
  mount();
  await waitFor(() => expect(state().tasks).toHaveLength(2));
  act(() => FakeSource.all[0].onopen?.());
  vi.mocked(api.tasks).mockClear();
  act(() => FakeSource.all[0].onerror?.());
  expect(FakeSource.all[0].closed).toBe(true);
  expect(state().connected).toBe(false);
  await waitFor(() => expect(FakeSource.all).toHaveLength(2));
  await waitFor(() => expect(api.tasks).toHaveBeenCalledTimes(2));
  act(() => last().onopen?.());
  expect(state().connected).toBe(true);
});
test('the pause starts over once the stream is open again (review finding 1)', async () => {
  mount(150);
  await waitFor(() => expect(state().loaded).toBe(true));
  act(() => last().onerror?.());
  await waitFor(() => expect(FakeSource.all).toHaveLength(2), { timeout: 1000 });
  act(() => last().onopen?.());
  // Second outage after a good connection: back to 150 ms, not 300 ms.
  act(() => last().onerror?.());
  await sleep(230);
  expect(FakeSource.all).toHaveLength(3);
});
test('coming back to the app reloads and reopens the stream (review finding 5)', async () => {
  mount();
  await waitFor(() => expect(state().loaded).toBe(true));
  act(() => last().onopen?.());
  vi.mocked(api.tenants).mockClear();
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(FakeSource.all[0].closed).toBe(true);
  expect(FakeSource.all).toHaveLength(2);
  await waitFor(() => expect(api.tenants).toHaveBeenCalledTimes(1));
});
test('an older reload that answers last never overwrites a newer one', async () => {
  mount();
  await waitFor(() => expect(state().loaded).toBe(true));
  let answerOld!: () => void;
  vi.mocked(api.tasks)
    .mockImplementationOnce(
      () => new Promise((done) => (answerOld = () => done([t('acme-old', 'acme')]))),
    )
    .mockImplementationOnce(async () => [t('acme-new', 'acme')]);
  let first!: Promise<void>;
  act(() => {
    first = current.reload(['acme']);
    void current.reload(['acme']);
  });
  await waitFor(() => expect(state().tasks).toEqual(['acme-new', 'globex-1']));
  await act(async () => {
    answerOld();
    await first;
  });
  expect(state().tasks).toEqual(['acme-new', 'globex-1']);
});
