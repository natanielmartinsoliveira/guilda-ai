import { MessagingService } from '../src/messaging/messaging.service';
jest.mock('amqplib', () => ({ connect: jest.fn() }));
import { connect } from 'amqplib';
type Mock = jest.Mock;
const fire = (target: { on: Mock }, event: string) =>
  target.on.mock.calls.filter(([e]) => e === event).forEach(([, cb]) => cb());
function channel(bad?: string) {
  const c = {
    on: jest.fn(),
    prefetch: jest.fn(),
    consume: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn(async (queue: string) => {
      if (queue !== bad) return;
      fire(c, 'close');
      throw new Error('PRECONDITION_FAILED');
    }),
  };
  return c;
}
function fixture(rows: object[] = [], error?: Error, bad?: string) {
  const pub = {
    on: jest.fn(),
    assertQueue: jest.fn(),
    sendToQueue: jest.fn((_q, _body, _options, cb) => {
      cb(error);
      return true;
    }),
  };
  const channels: ReturnType<typeof channel>[] = [];
  const connection = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    createConfirmChannel: jest.fn().mockResolvedValue(pub),
    createChannel: jest.fn(async () => {
      const c = channel(bad);
      channels.push(c);
      return c;
    }),
  };
  (connect as Mock).mockResolvedValue(connection);
  const query = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
  const db = { transaction: jest.fn(async (cb) => cb({ query })) };
  return { pub, query, channels, connection, service: new MessagingService(db as any) };
}
const row = (id: string, tenantId = 'acme') => ({
  id,
  taskId: 'task',
  issueId: 'issue',
  type: 'CODE',
  provider: 'codex',
  tenantId,
});
type Fixture = ReturnType<typeof fixture>;
const asserted = (x: Fixture, queue: string) =>
  [x.pub, ...x.channels].flatMap((c) => c.assertQueue.mock.calls).filter(([q]) => q === queue)
    .length;
/** Channels that consume, in the order they were opened. */
const consumers = (x: Fixture) => x.channels.filter((c) => c.consume.mock.calls.length);
const consumed = (x: Fixture) =>
  consumers(x).map((c) => [c.consume.mock.calls[0][0], c.prefetch.mock.calls[0][0]]);

test('a task is published to its company queue, confirmed before the outbox is marked', async () => {
  const x = fixture([row('outbox-id')]);
  await x.service.tick();
  const declared = x.channels.flatMap((c) => c.assertQueue.mock.calls);
  expect(declared).toContainEqual(['ai-dev-tasks.acme.dead', { durable: true }]);
  expect(declared).toContainEqual([
    'ai-dev-tasks.acme',
    {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'ai-dev-tasks.acme.dead',
      },
    },
  ]);
  expect(x.pub.sendToQueue).toHaveBeenCalledWith(
    'ai-dev-tasks.acme',
    expect.any(Buffer),
    expect.objectContaining({ persistent: true, messageId: 'outbox-id' }),
    expect.any(Function),
  );
  const body = JSON.parse((x.pub.sendToQueue.mock.calls[0][1] as Buffer).toString());
  expect(body).toEqual({ taskId: 'task', issueId: 'issue', type: 'CODE', provider: 'codex' });
  expect(x.query.mock.calls[0][0]).toContain('t."tenantId"');
  expect(x.query.mock.calls[1][0]).toContain('UPDATE outbox');
  expect(x.pub.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(
    x.query.mock.invocationCallOrder[1],
  );
});
test('a company queue is asserted once per connection; each company gets its own', async () => {
  const x = fixture([row('a'), row('b'), row('c', 'globex')]);
  await x.service.tick();
  expect(asserted(x, 'ai-dev-tasks.acme')).toBe(1);
  expect(asserted(x, 'ai-dev-tasks.globex')).toBe(1);
  expect(x.pub.sendToQueue.mock.calls.map(([q]) => q)).toEqual([
    'ai-dev-tasks.acme',
    'ai-dev-tasks.acme',
    'ai-dev-tasks.globex',
  ]);
});
test('unconfirmed publication never marks the outbox delivered', async () => {
  const x = fixture([row('outbox-id')], new Error('connection lost'));
  await x.service.tick();
  expect(x.query).toHaveBeenCalledTimes(1);
});
test('the worker consumes the legacy queue with prefetch 1 and one queue per company', async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [
    { tenantId: 'acme', concurrency: 2 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  expect(consumed(x)).toEqual([
    ['ai-dev-tasks', 1],
    ['ai-dev-tasks.acme', 2],
    ['ai-dev-tasks.globex', 1],
  ]);
  expect(asserted(x, 'ai-dev-tasks.globex')).toBe(1);
  await x.service.tick();
  expect(consumers(x)).toHaveLength(3);
});
test("one company's channel closing leaves the others and is reopened alone", async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [
    { tenantId: 'acme', concurrency: 2 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  const [, acme, globex] = consumers(x);
  fire(acme, 'close');
  await x.service.tick();
  expect(consumers(x)).toHaveLength(4);
  expect(consumed(x)[3]).toEqual(['ai-dev-tasks.acme', 2]);
  expect(globex.close).not.toHaveBeenCalled();
});
test('connection lost: next tick asserts again and reopens every consumer', async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [{ tenantId: 'acme', concurrency: 1 }]);
  await x.service.tick();
  fire(x.pub, 'close');
  fire(x.connection, 'close');
  await x.service.tick();
  expect(asserted(x, 'ai-dev-tasks.acme')).toBe(2);
  expect(consumed(x).slice(2)).toEqual([
    ['ai-dev-tasks', 1],
    ['ai-dev-tasks.acme', 1],
  ]);
});
test('a company whose queue is refused (406) does not stop the others nor publishing', async () => {
  const x = fixture([row('a', 'acme'), row('b', 'globex')], undefined, 'ai-dev-tasks.acme');
  x.service.consume(jest.fn(), [
    { tenantId: 'acme', concurrency: 1 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  expect(consumed(x).map(([q]) => q)).toEqual(['ai-dev-tasks', 'ai-dev-tasks.globex']);
  expect(x.pub.sendToQueue.mock.calls.map(([q]) => q)).toEqual(['ai-dev-tasks.globex']);
  const marked = x.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE outbox'));
  expect(marked.map(([, args]) => args)).toEqual([['b']]);
  await x.service.tick();
  expect(x.connection.close).not.toHaveBeenCalled();
  expect(consumers(x)).toHaveLength(2);
});
test('only the publisher channel lost: it is reopened without dropping the consumers', async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [{ tenantId: 'acme', concurrency: 1 }]);
  await x.service.tick();
  fire(x.pub, 'close');
  await x.service.tick();
  expect(x.connection.createConfirmChannel).toHaveBeenCalledTimes(2);
  expect(x.connection.close).not.toHaveBeenCalled();
  expect(consumers(x)).toHaveLength(2);
});
test('an infrastructure failure in the handler closes only that channel', async () => {
  const x = fixture();
  const handler = jest.fn().mockRejectedValue(new Error('db down'));
  x.service.consume(handler, [
    { tenantId: 'acme', concurrency: 1 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  const [legacy, acme, globex] = consumers(x);
  const deliver = acme.consume.mock.calls[0][1];
  deliver({ content: Buffer.from('{}') });
  await new Promise((r) => setImmediate(r));
  expect(acme.close).toHaveBeenCalled();
  expect(legacy.close).not.toHaveBeenCalled();
  expect(globex.close).not.toHaveBeenCalled();
});
