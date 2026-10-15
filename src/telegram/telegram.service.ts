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
  /** Button clicks from the operator's chat answer failure decisions; anything else is ignored. */
  async handleUpdate(update: TelegramUpdate) {
    const chat = config().TELEGRAM_CHAT_ID!;
    const query = update.callback_query;
    if (!query) {
      if (update.message && String(update.message.chat.id) !== chat)
        log('telegram.foreign_chat', { chat: update.message.chat.id });
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
    for (let attempt = 1; ; attempt++) {
      try {
        await this.orchestrator.answerDecision(
          decision.tenantId,
          decision.id,
          { action: parsed.action },
          'telegram',
        );
        break;
      } catch (error) {
        if (!(error instanceof JobRejected)) throw error;
        const running = /running right now/.test(error.message);
        if (running && attempt < RUNNING_RETRIES) {
          await this.wait(2000);
          continue;
        }
        return this.client().answerCallbackQuery(
          query.id,
          running
            ? t('telegram.callback.running')
            : /already answered/.test(error.message)
              ? t('telegram.callback.alreadyAnswered')
              : error.message.slice(0, 180),
        );
      }
    }
    const label =
      parsed.action === 'retry'
        ? t('telegram.callback.labelRetry')
        : t('telegram.callback.labelCancel');
    await this.client().answerCallbackQuery(
      query.id,
      parsed.action === 'retry'
        ? t('telegram.callback.doneRetry')
        : t('telegram.callback.doneCancel'),
    );
    if (query.message)
      await this.client()
        .editMessageText(
          chat,
          String(query.message.message_id),
          `${query.message.text ?? ''}\n\n${t('telegram.callback.viaTelegram', { label })}`.slice(
            0,
            4096,
          ),
        )
        .catch(() => undefined);
  }
}
