import { TaskWorkerService } from '../src/tasks/task-worker.service';
import { databaseOptions, DB_POOL } from '../src/database/data-source';
const workerFor = (concurrency: number[], messaging = { consume: jest.fn() }) => {
  const tenants = {
    all: () => concurrency.map((c, i) => ({ id: `t${i}`, worker: { concurrency: c } })),
  };
  const none = {} as never;
  return new TaskWorkerService(
    none,
    messaging as never,
    none,
    none,
    none,
    tenants as never,
    none,
    none,
    none,
    none,
    none,
    none,
  );
};
test('the worker consumes one queue per company with its concurrency', () => {
  const messaging = { consume: jest.fn() };
  const tenants = {
    all: () => [
      { id: 'acme', worker: { concurrency: 2 } },
      { id: 'globex', worker: { concurrency: 1 } },
    ],
  };
  const none = {} as never;
  const worker = new TaskWorkerService(
    none,
    messaging as never,
    none,
    none,
    none,
    tenants as never,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  worker.onModuleInit();
  expect(messaging.consume).toHaveBeenCalledWith(expect.any(Function), [
    { tenantId: 'acme', concurrency: 2 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
});
test('the database pool has room for every task that may run at once, and a bounded wait', () => {
  expect(databaseOptions()).toMatchObject({
    extra: { max: DB_POOL, connectionTimeoutMillis: 30_000 },
  });
});
test('more tasks at once than the database pool can hold: the worker refuses to start', () => {
  // Each running task holds one connection (its session lock) for the whole run.
  expect(() => workerFor([8, 8, 8, 2]).onModuleInit()).toThrow(/pool/);
  expect(() => workerFor([8, 8, 8]).onModuleInit()).not.toThrow();
});
