import { taskMetrics } from '../src/tasks/metrics';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 12, minutes));
const run = (agent: string, from: number, to: number | null, phase: string | null = null) => ({
  agent,
  phase,
  usage: null,
  startedAt: at(from),
  finishedAt: to === null ? null : at(to),
});

test('a task splits into agent time, time waiting on the person and the rest', () => {
  const m = taskMetrics(
    { status: 'SUCCESS', createdAt: at(0), updatedAt: at(100) },
    [
      run('capability-check', 0, 1),
      run('coder', 1, 21, 'spec'),
      run('coder', 50, 80, 'deliver'),
      run('method-hook', 80, 85),
    ],
    [
      {
        type: 'question',
        status: 'answered',
        createdAt: at(21),
        answeredAt: at(45),
        updatedAt: at(45),
      },
      {
        type: 'failure',
        status: 'answered',
        createdAt: at(85),
        answeredAt: at(90),
        updatedAt: at(90),
      },
    ],
  );
  expect(m).toMatchObject({
    totalMs: 100 * 60000,
    agentMs: 50 * 60000,
    waitingMs: 29 * 60000,
    otherMs: 21 * 60000,
    waits: { questions: 1, failures: 1 },
  });
  expect(m.phases).toEqual({
    spec: { runs: 1, agentMs: 20 * 60000 },
    deliver: { runs: 1, agentMs: 30 * 60000 },
  });
});

test('a live task counts up to now: the running agent and the open question too', () => {
  const m = taskMetrics(
    { status: 'WAITING', createdAt: at(0), updatedAt: at(5) },
    [run('coder', 0, null, 'deliver')],
    [{ type: 'question', status: 'open', createdAt: at(0), answeredAt: null, updatedAt: at(0) }],
    at(10),
  );
  expect(m).toMatchObject({
    totalMs: 10 * 60000,
    agentMs: 10 * 60000,
    waitingMs: 10 * 60000,
    otherMs: 0,
  });
});

test('phase usage is summed from the runs that carry it', () => {
  const usage = { input: 10, output: 1, cacheCreation: 0, cacheRead: 5 };
  const m = taskMetrics(
    { status: 'SUCCESS', createdAt: at(0), updatedAt: at(10) },
    [
      { ...run('coder', 0, 2, 'deliver'), usage },
      { ...run('coder', 2, 4, 'deliver'), usage },
    ],
    [],
  );
  expect(m.phases.deliver.usage).toEqual({ input: 20, output: 2, cacheCreation: 0, cacheRead: 10 });
});
