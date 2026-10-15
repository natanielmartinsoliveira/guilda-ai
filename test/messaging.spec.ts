import { MessagingService } from '../src/messaging/messaging.service';
jest.mock('amqplib', () => ({ connect: jest.fn() }));
import { connect } from 'amqplib';
function fixture(error?: Error) {
  const pub = {
    on: jest.fn(),
    assertQueue: jest.fn(),
    sendToQueue: jest.fn((_q, _body, _options, cb) => {
      cb(error);
      return true;
    }),
  };
  (connect as jest.Mock).mockResolvedValue({
    on: jest.fn(),
    createConfirmChannel: jest.fn().mockResolvedValue(pub),
  });
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      { id: 'outbox-id', taskId: 'task', issueId: 'issue', type: 'CODE', provider: 'codex' },
    ])
    .mockResolvedValue([]);
  const db = { transaction: jest.fn(async (cb) => cb({ query })) };
  return { pub, query, service: new MessagingService(db as any) };
}
test('durable task publication is confirmed before marking outbox published', async () => {
  const x = fixture();
  await x.service.tick();
  expect(x.pub.assertQueue).toHaveBeenCalledWith(
    'ai-dev-tasks',
    expect.objectContaining({ durable: true }),
  );
  expect(x.pub.sendToQueue).toHaveBeenCalledWith(
    'ai-dev-tasks',
    expect.any(Buffer),
    expect.objectContaining({ persistent: true, messageId: 'outbox-id' }),
    expect.any(Function),
  );
  expect(x.query.mock.calls[1][0]).toContain('UPDATE outbox');
  expect(x.pub.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(
    x.query.mock.invocationCallOrder[1],
  );
});
test('unconfirmed publication never marks the outbox delivered', async () => {
  const x = fixture(new Error('connection lost'));
  await x.service.tick();
  expect(x.query).toHaveBeenCalledTimes(1);
});
