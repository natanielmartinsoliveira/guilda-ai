import { TelegramClient, TelegramError } from '../src/telegram/telegram.client';
describe('TelegramClient', () => {
  const token = '123456:abcdefghijklmnopqrstuvwxyz';
  test('sends a plain-text message with buttons and returns its id', async () => {
    const http = jest.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }),
    );
    const client = new TelegramClient(token, http as unknown as typeof fetch);
    const keyboard = { inline_keyboard: [[{ text: 'R', callback_data: 'd:x:retry' }]] };
    expect(await client.sendMessage('123456789', 'oi', keyboard)).toEqual({ messageId: '42' });
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '123456789',
      text: 'oi',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
  test('an API error never carries the token', async () => {
    const http = jest.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
          status: 400,
        }),
    );
    const client = new TelegramClient(token, http as unknown as typeof fetch);
    const error = await client.sendMessage('1', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String((error as Error).message)).toBe(
      'Telegram sendMessage: Bad Request: chat not found',
    );
    expect(String((error as Error).message)).not.toContain(token);
  });
  test('network failures become TelegramError without the URL', async () => {
    const http = jest.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getUpdates`);
    });
    const client = new TelegramClient(token, http as unknown as typeof fetch);
    const error = await client.getUpdates(undefined, 1).catch((e: unknown) => e);
    expect(String((error as Error).message)).toBe('Telegram getUpdates: network error');
  });
});
import { DataSource } from 'typeorm';
import * as settings from '../src/config';
import { database, item } from './db';
import { TelegramService } from '../src/telegram/telegram.service';
import { JobRejected, OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { Decision, Notification, Task } from '../src/database/entities';
describe('TelegramService', () => {
  let db: DataSource;
  const chat = '123456789';
  beforeEach(async () => {
    db = await database();
    jest.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_CHAT_ID: chat,
      WEB_PUBLIC_URL: undefined,
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });
  function setup() {
    const fake = {
      sendMessage: jest.fn().mockResolvedValue({ messageId: '77' }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      getUpdates: jest.fn().mockResolvedValue([]),
    };
    const orchestrator = new OrchestratorService(db, new TenantRegistry());
    class TestService extends TelegramService {
      protected client() {
        return fake as never;
      }
      /** No real waiting between retries in tests. */
      protected async wait() {}
    }
    return { fake, orchestrator, service: new TestService(db, orchestrator) };
  }
  async function failed(orchestrator: OrchestratorService) {
    const task = await orchestrator.accept('acme', item);
    await db.getRepository(Task).update(task.id, { status: 'FAILED', stage: 'TESTS' });
    const decision = await db.getRepository(Decision).save({
      tenantId: 'acme',
      taskId: task.id,
      revisionId: null,
      type: 'failure',
      status: 'open',
      reason: 'TESTS: Tests failed: boom',
    });
    await db.getRepository(Notification).save({ kind: 'decision', decisionId: decision.id });
    return { task, decision };
  }
  const click = (decisionId: string, action: string, from = Number(chat)) => ({
    update_id: 1,
    callback_query: {
      id: 'cb1',
      data: `d:${decisionId}:${action}`,
      from: { id: from },
      message: { message_id: 77, chat: { id: from }, text: '❌ Acme · #7 falhou' },
    },
  });
  test('sends pending warnings once, with the buttons of a failure, and remembers the message', async () => {
    const x = setup();
    const { decision } = await failed(x.orchestrator);
    expect(await x.service.sendPending()).toBe(1);
    const [to, text, keyboard] = x.fake.sendMessage.mock.calls[0];
    expect(to).toBe(chat);
    expect(text).toContain('❌ Acme · #7 falhou');
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe(`d:${decision.id}:retry`);
    expect(
      await db.getRepository(Notification).findOneByOrFail({ decisionId: decision.id }),
    ).toMatchObject({ status: 'sent', messageId: '77' });
    expect(await x.service.sendPending()).toBe(0);
  });
  test('a failed send is retried later, then given up after 10 attempts', async () => {
    const x = setup();
    await failed(x.orchestrator);
    x.fake.sendMessage.mockRejectedValue(new Error('Telegram sendMessage: network error'));
    await x.service.sendPending();
    let n = await db.getRepository(Notification).findOneByOrFail({});
    expect(n).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Telegram sendMessage: network error',
    });
    expect(n.availableAt.getTime()).toBeGreaterThan(Date.now());
    await db.getRepository(Notification).update(n.id, { attempts: 9, availableAt: new Date(0) });
    await x.service.sendPending();
    n = await db.getRepository(Notification).findOneByOrFail({});
    expect(n).toMatchObject({ status: 'failed', attempts: 10 });
  });
  test('Retry button answers the decision via Telegram and edits the message', async () => {
    const x = setup();
    const { task, decision } = await failed(x.orchestrator);
    await x.service.handleUpdate(click(decision.id, 'retry'));
    expect((await db.getRepository(Task).findOneByOrFail({ id: task.id })).status).toBe('PENDING');
    expect(await db.getRepository(Decision).findOneByOrFail({ id: decision.id })).toMatchObject({
      status: 'answered',
      answeredVia: 'telegram',
      answer: { action: 'retry' },
    });
    expect(x.fake.answerCallbackQuery).toHaveBeenCalledWith('cb1', 'Feito: repetindo a tarefa.');
    expect(x.fake.editMessageText).toHaveBeenCalledWith(
      chat,
      '77',
      expect.stringContaining('→ Repetir (pelo Telegram)'),
    );
  });
  test('a second click, or a click after answering elsewhere, does nothing twice', async () => {
    const x = setup();
    const { decision } = await failed(x.orchestrator);
    await x.service.handleUpdate(click(decision.id, 'cancel'));
    await x.service.handleUpdate(click(decision.id, 'retry'));
    expect(x.fake.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      'Essa decisão já foi respondida.',
    );
    expect((await db.getRepository(Decision).findOneByOrFail({ id: decision.id })).answer).toEqual({
      action: 'cancel',
    });
  });
  test('clicks from another chat are ignored', async () => {
    const x = setup();
    const { decision } = await failed(x.orchestrator);
    await x.service.handleUpdate(click(decision.id, 'retry', 111));
    expect(x.fake.answerCallbackQuery).not.toHaveBeenCalled();
    expect((await db.getRepository(Decision).findOneByOrFail({ id: decision.id })).status).toBe(
      'open',
    );
  });
  test('an already answered decision says so at once, even while its task runs', async () => {
    const x = setup();
    const { decision } = await failed(x.orchestrator);
    await db.getRepository(Decision).update(decision.id, { status: 'answered' });
    const spy = jest.spyOn(x.orchestrator, 'answerDecision');
    await x.service.handleUpdate(click(decision.id, 'retry'));
    expect(spy).not.toHaveBeenCalled();
    expect(x.fake.answerCallbackQuery).toHaveBeenCalledWith(
      'cb1',
      'Essa decisão já foi respondida.',
    );
  });
  test('a text warning is sent as is (redacted)', async () => {
    const x = setup();
    await db.getRepository(Notification).save({
      kind: 'text',
      payload: { text: '🔐 Novo acesso ao front (IP 1.2.3.4)' },
    });
    expect(await x.service.sendPending()).toBe(1);
    expect(x.fake.sendMessage).toHaveBeenCalledWith(
      chat,
      '🔐 Novo acesso ao front (IP 1.2.3.4)',
      undefined,
    );
  });
  test('while the task is running, the click waits and tries again', async () => {
    const x = setup();
    const { decision } = await failed(x.orchestrator);
    const real = x.orchestrator.answerDecision.bind(x.orchestrator);
    jest
      .spyOn(x.orchestrator, 'answerDecision')
      .mockRejectedValueOnce(
        new JobRejected('conflict', 'The task is running right now; try later'),
      )
      .mockImplementation(real);
    await x.service.handleUpdate(click(decision.id, 'retry'));
    expect(x.orchestrator.answerDecision).toHaveBeenCalledTimes(2);
    expect(x.fake.answerCallbackQuery).toHaveBeenCalledWith('cb1', 'Feito: repetindo a tarefa.');
  });
});
