import { TaskWorkerService } from '../src/tasks/task-worker.service';
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
