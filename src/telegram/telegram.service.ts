import { t } from '../i18n';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { config, log, redact } from '../config';
import { Decision, Issue, Notification, Task } from '../database/entities';
import { JobRejected, OrchestratorService } from '../tasks/orchestrator.service';
import { findTenant } from '../tenants/tenants';
import { telegramEnabled } from './enabled';
import { decisionMessage, parseCallback, prMessage } from './messages';
import { TelegramClient, TelegramUpdate } from './telegram.client';
const MAX_SEND_ATTEMPTS = 10;
const RUNNING_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/**
 * Operator warnings over Telegram: sends queued notifications (retrying) and turns button
 * clicks into decision answers. Runs in the API process; each loop holds an advisory lock so
 * only one process sends and only one reads updates.
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;
  private offset: number | undefined;
  constructor(
    private readonly db: DataSource,
    private readonly orchestrator: OrchestratorService,
  ) {}
  /** Overridable in tests. */
  protected client() {
    return new TelegramClient(config().TELEGRAM_BOT_TOKEN!);
  }
  /** Pause between "task is running" retries; overridable in tests. */
  protected wait(ms: number) {
    return sleep(ms);
  }
  onModuleInit() {
    if (!telegramEnabled() || !config().SOURCE_POLLING) return;
    void this.loop('telegram:send', 3000, () => this.sendPending());
    void this.loop('telegram:poll', 0, () => this.poll());
  }
  onModuleDestroy() {
    this.stopped = true;
  }
  private async loop(key: string, pauseMs: number, work: () => Promise<unknown>) {
    while (!this.stopped) {
      const lock = this.db.createQueryRunner();
      try {
        await lock.connect();
        const [{ locked }] = await lock.query(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [key],
        );
        if (locked)
          try {
            while (!this.stopped) {
              await work();
              if (pauseMs) await sleep(pauseMs);
            }
          } finally {
            await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
          }
      } catch (error) {
        log('telegram.loop_failed', {
          key,
          error: redact(error instanceof Error ? error.message : String(error)),
        });
      } finally {
        await lock.release().catch(() => undefined);
      }
      // Another process owns the loop, or it failed: look again later.
      if (!this.stopped) await sleep(15000);
    }
  }
  /** Sends what is due; returns how many were sent. */
  async sendPending(): Promise<number> {
    const due = await this.db.getRepository(Notification).find({
      where: { status: 'pending', availableAt: LessThanOrEqual(new Date()) },
      order: { createdAt: 'ASC' },
      take: 20,
    });
    let sent = 0;
    for (const n of due) {
      try {
        const message = await this.render(n);
        const { messageId } = await this.client().sendMessage(
          config().TELEGRAM_CHAT_ID!,
          message.text,
          message.keyboard,
        );
        await this.db.getRepository(Notification).update(n.id, {
          status: 'sent',
          sentAt: new Date(),
          messageId,
          attempts: n.attempts + 1,
          lastError: null,
        });
        sent++;
      } catch (error) {
        const attempts = n.attempts + 1;
        const lastError = redact(error instanceof Error ? error.message : String(error)).slice(
          0,
          500,
        );
        await this.db.getRepository(Notification).update(n.id, {
          attempts,
          lastError,
          status: attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'pending',
          // 30 s, 1 min, 2 min... up to 1 h between attempts.
          availableAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** (attempts - 1)) * 1000),
        });
        log('telegram.send_failed', { notificationId: n.id, attempts, error: lastError });
      }
    }
    return sent;
  }
  private async render(n: Notification) {
    if (n.kind === 'text')
      return { text: redact(String((n.payload as { text?: string } | null)?.text ?? '')) };
    if (n.kind === 'pr') {
      const p = n.payload as { tenantId: string; card: string; title: string; prUrl: string };
      return {
        text: redact(prMessage({ ...p, tenantName: findTenant(p.tenantId)?.name ?? p.tenantId })),
      };
    }
    const decision = await this.db.getRepository(Decision).findOneByOrFail({ id: n.decisionId! });
    const task = await this.db.getRepository(Task).findOneByOrFail({ id: decision.taskId });
    const issue = await this.db.getRepository(Issue).findOneBy({ id: task.issueId });
    const base = config().WEB_PUBLIC_URL?.replace(/\/+$/, '');
    const message = decisionMessage({
      decision,
      tenantName: findTenant(decision.tenantId)?.name ?? decision.tenantId,
      card: issue?.externalKey ?? '',
      title: issue?.title ?? '',
      link: base ? `${base}/app/decisoes/${decision.id}` : undefined,
    });
    return { ...message, text: redact(message.text) };
  }
  private async poll() {
    const updates = await this.client().getUpdates(this.offset, 25);
    for (const update of updates) {
      this.offset = update.update_id + 1;
      await this.handleUpdate(update).catch((error: unknown) =>
        log('telegram.update_failed', {
          error: redact(error instanceof Error ? error.message : String(error)),
        }),
      );
    }
  }
  /**
   * From the operator's chat only: buttons answer decisions (retry/cancel a failure, or an option
   * of a question), and "Reply" to a decision warning answers its questions with the text.
   */
  async handleUpdate(update: TelegramUpdate) {
    const chat = config().TELEGRAM_CHAT_ID!;
    const query = update.callback_query;
    if (!query) {
      const message = update.message;
      if (!message) return;
      if (String(message.chat.id) !== chat || (message.from && String(message.from.id) !== chat)) {
        log('telegram.foreign_chat', { chat: message.chat.id });
        return;
      }
      if (message.reply_to_message) await this.reply(chat, message);
      return;
    }
    if (String(query.from.id) !== chat || String(query.message?.chat.id) !== chat) {
      log('telegram.foreign_click', { from: query.from.id });
      return;
    }
    const parsed = parseCallback(query.data ?? '');
    if (!parsed)
      return this.client().answerCallbackQuery(query.id, t('telegram.callback.unknownButton'));
    const decision = await this.db.getRepository(Decision).findOneBy({ id: parsed.decisionId });
    if (!decision)
      return this.client().answerCallbackQuery(query.id, t('telegram.callback.notFound'));
    // Answered already (another click, the VS Code, the front): no need to wait on the task.
    if (decision.status !== 'open')
      return this.client().answerCallbackQuery(query.id, t('telegram.callback.alreadyAnswered'));
    let answer: { action: 'retry' | 'cancel' } | { answers: string[] };
    let shown: string;
    if (parsed.action === 'option') {
      const options = decision.questions?.length === 1 ? (decision.questions[0].options ?? []) : [];
      const option = options[parsed.option];
      if (decision.type !== 'question' || option === undefined)
        return this.client().answerCallbackQuery(query.id, t('telegram.callback.unknownButton'));
      answer = { answers: [option] };
      shown = t('telegram.callback.viaTelegramAnswer', { answer: option.slice(0, 300) });
    } else {
      answer = { action: parsed.action };
      shown = t('telegram.callback.viaTelegram', {
        label:
          parsed.action === 'retry'
            ? t('telegram.callback.labelRetry')
            : t('telegram.callback.labelCancel'),
      });
    }
    const refused = await this.submit(decision, answer);
    if (refused) return this.client().answerCallbackQuery(query.id, refused);
    await this.client().answerCallbackQuery(
      query.id,
      parsed.action === 'option'
        ? t('telegram.callback.doneAnswer')
        : parsed.action === 'retry'
          ? t('telegram.callback.doneRetry')
          : t('telegram.callback.doneCancel'),
    );
    if (query.message)
      await this.client()
        .editMessageText(
          chat,
          String(query.message.message_id),
          `${query.message.text ?? ''}\n\n${shown}`.slice(0, 4096),
        )
        .catch(() => undefined);
  }
  /** "Reply" to a decision warning: the text answers its questions (one numbered line each). */
  private async reply(chat: string, message: NonNullable<TelegramUpdate['message']>) {
    const to = message.reply_to_message!;
    const sent = await this.db.getRepository(Notification).findOneBy({
      kind: 'decision',
      messageId: String(to.message_id),
    });
    if (!sent?.decisionId) return;
    const decision = await this.db.getRepository(Decision).findOneBy({ id: sent.decisionId });
    if (!decision) return;
    const say = (text: string) => this.client().sendMessage(chat, text);
    if (decision.status !== 'open') return say(t('telegram.callback.alreadyAnswered'));
    if (decision.type !== 'question') return say(t('telegram.reply.useButtons'));
    const count = decision.questions?.length ?? 0;
    const answers = replyAnswers(message.text ?? '', count);
    if (!answers) return say(t('telegram.reply.format', { count }));
    const refused = await this.submit(decision, { answers });
    if (refused) return say(refused);
    await say(t('telegram.reply.done'));
    await this.client()
      .editMessageText(
        chat,
        String(to.message_id),
        `${to.text ?? ''}\n\n${t('telegram.callback.viaTelegramAnswer', {
          answer: answers.join(' / ').slice(0, 300),
        })}`.slice(0, 4096),
      )
      .catch(() => undefined);
  }
  /** Answers the decision via Telegram; returns why it was refused, if it was. */
  private async submit(
    decision: Decision,
    answer: { action: 'retry' | 'cancel' } | { answers: string[] },
  ): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.orchestrator.answerDecision(decision.tenantId, decision.id, answer, 'telegram');
        return undefined;
      } catch (error) {
        if (!(error instanceof JobRejected)) throw error;
        const running = /running right now/.test(error.message);
        if (running && attempt < RUNNING_RETRIES) {
          await this.wait(2000);
          continue;
        }
        return running
          ? t('telegram.callback.running')
          : /already answered/.test(error.message)
            ? t('telegram.callback.alreadyAnswered')
            : error.message.slice(0, 180);
      }
    }
  }
}
/**
 * The answers in a reply: the whole text for one question; for several, one numbered line each
 * ("1. …" or "1) …", continuation lines kept with their answer). Undefined when any is missing.
 */
export function replyAnswers(text: string, count: number): string[] | undefined {
  const body = text.trim();
  if (!body || count < 1) return undefined;
  if (count === 1) return [body.slice(0, 4000)];
  const answers: string[] = [];
  let current = -1;
  for (const line of body.split('\n')) {
    const numbered = /^\s*(\d{1,2})\s*[.)]\s*(.*)$/.exec(line);
    if (numbered && Number(numbered[1]) === current + 2) {
      current++;
      answers[current] = numbered[2];
    } else if (current >= 0) answers[current] += `\n${line}`;
    else return undefined;
  }
  const trimmed = answers.map((a) => a.trim().slice(0, 4000));
  return trimmed.length === count && trimmed.every(Boolean) ? trimmed : undefined;
}
