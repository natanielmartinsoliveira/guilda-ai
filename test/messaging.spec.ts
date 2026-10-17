import { MessagingService } from '../src/messaging/messaging.service';
jest.mock('amqplib', () => ({ connect: jest.fn() }));
import { connect } from 'amqplib';
type Mock = jest.Mock;
const fire = (target: { on: Mock }, event: string) =>
  target.on.mock.calls.filter(([e]) => e === event).forEach(([, cb]) => cb());
function channel() {
  return {
    on: jest.fn(),
    prefetch: jest.fn(),
    consume: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}
function fixture(rows: object[] = [], error?: Error) {
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
      const c = channel();
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
const asserted = (pub: { assertQueue: Mock }, queue: string) =>
  pub.assertQueue.mock.calls.filter(([q]) => q === queue).length;
const consumed = (x: ReturnType<typeof fixture>) =>
  x.channels.map((c) => [c.consume.mock.calls[0]?.[0], c.prefetch.mock.calls[0]?.[0]]);

test('a task is published to its company queue, confirmed before the outbox is marked', async () => {
  const x = fixture([row('outbox-id')]);
  await x.service.tick();
  expect(x.pub.assertQueue).toHaveBeenCalledWith('ai-dev-tasks.acme.dead', { durable: true });
  expect(x.pub.assertQueue).toHaveBeenCalledWith('ai-dev-tasks.acme', {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': 'ai-dev-tasks.acme.dead',
    },
  });
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
  expect(asserted(x.pub, 'ai-dev-tasks.acme')).toBe(1);
  expect(asserted(x.pub, 'ai-dev-tasks.globex')).toBe(1);
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
  expect(asserted(x.pub, 'ai-dev-tasks.globex')).toBe(1);
  await x.service.tick();
  expect(x.channels).toHaveLength(3);
});
test("one company's channel closing leaves the others and is reopened alone", async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [
    { tenantId: 'acme', concurrency: 2 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  fire(x.channels[1], 'close');
  await x.service.tick();
  expect(x.channels).toHaveLength(4);
  expect(consumed(x)[3]).toEqual(['ai-dev-tasks.acme', 2]);
  expect(x.channels[2].close).not.toHaveBeenCalled();
});
test('connection lost: next tick asserts again and reopens every consumer', async () => {
  const x = fixture();
  x.service.consume(jest.fn(), [{ tenantId: 'acme', concurrency: 1 }]);
  await x.service.tick();
  fire(x.pub, 'close');
  fire(x.connection, 'close');
  await x.service.tick();
  expect(asserted(x.pub, 'ai-dev-tasks.acme')).toBe(2);
  expect(consumed(x).slice(2)).toEqual([
    ['ai-dev-tasks', 1],
    ['ai-dev-tasks.acme', 1],
  ]);
});
test('a company whose channel cannot open does not stop the others nor publishing', async () => {
  const x = fixture([row('outbox-id', 'globex')]);
  x.connection.createChannel
    .mockImplementationOnce(async () => {
      const c = channel();
      x.channels.push(c);
      return c;
    })
    .mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
  x.service.consume(jest.fn(), [
    { tenantId: 'acme', concurrency: 1 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  expect(consumed(x).map(([q]) => q)).toEqual(['ai-dev-tasks', 'ai-dev-tasks.globex']);
  expect(x.pub.sendToQueue).toHaveBeenCalledTimes(1);
  await x.service.tick();
  expect(consumed(x).map(([q]) => q)).toContain('ai-dev-tasks.acme');
});
test('an infrastructure failure in the handler closes only that channel', async () => {
  const x = fixture();
  const handler = jest.fn().mockRejectedValue(new Error('db down'));
  x.service.consume(handler, [
    { tenantId: 'acme', concurrency: 1 },
    { tenantId: 'globex', concurrency: 1 },
  ]);
  await x.service.tick();
  const deliver = x.channels[1].consume.mock.calls[0][1];
  deliver({ content: Buffer.from('{}') });
  await new Promise((r) => setImmediate(r));
  expect(x.channels[1].close).toHaveBeenCalled();
  expect(x.channels[0].close).not.toHaveBeenCalled();
  expect(x.channels[2].close).not.toHaveBeenCalled();
});
