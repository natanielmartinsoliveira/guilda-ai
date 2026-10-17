import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as amqp from 'amqplib';
import { config, log } from '../config';
/** Before queues per company; still drained, never published to. */
export const QUEUE = 'ai-dev-tasks';
/** The queue of one company: its tasks never wait behind another company's. */
export const queueOf = (tenantId: string) => `${QUEUE}.${tenantId}`;
/** A company's queue and how many of its tasks run at once. */
export interface Slot {
  tenantId: string;
  concurrency: number;
}
type Handler = (message: amqp.ConsumeMessage, channel: amqp.Channel) => Promise<void>;
@Injectable()
export class MessagingService implements OnModuleInit, OnModuleDestroy {
  private connection?: amqp.ChannelModel;
  private publisher?: amqp.ConfirmChannel;
  /** One consumer channel per queue: one closing never stops the others. */
  private readonly consumers = new Map<string, amqp.Channel>();
  /** Queues declared on the current publisher channel. */
  private readonly asserted = new Set<string>();
  private handler?: Handler;
  private slots: Slot[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  constructor(private readonly db: DataSource) {}
  consume(handler: Handler, slots: Slot[] = []) {
    this.handler = handler;
    this.slots = slots;
  }
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.connection?.close().catch(() => {});
  }
  private async ensure(queue: string) {
    if (this.asserted.has(queue)) return;
    await this.publisher!.assertQueue(`${queue}.dead`, { durable: true });
    await this.publisher!.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': `${queue}.dead` },
    });
    this.asserted.add(queue);
  }
  private async connect() {
    if (!this.publisher) {
      if (this.connection) await this.connection.close().catch(() => {});
      const connection = await amqp.connect(config().RABBITMQ_URL, { timeout: 10000 });
      connection.on('error', () => log('rabbitmq.connection_error'));
      connection.on('close', () => {
        this.publisher = undefined;
        this.consumers.clear();
        this.asserted.clear();
        this.connection = undefined;
      });
      this.connection = connection;
      const pub = await connection.createConfirmChannel();
      pub.on('error', () => log('rabbitmq.channel_error'));
      pub.on('close', () => {
        this.publisher = undefined;
        this.asserted.clear();
      });
      this.publisher = pub;
      await this.ensure(QUEUE);
    }
    if (!this.handler) return;
    const wanted: [string, number][] = [
      [QUEUE, 1],
      ...this.slots.map((s): [string, number] => [queueOf(s.tenantId), s.concurrency]),
    ];
    for (const [queue, prefetch] of wanted) {
      if (this.consumers.has(queue)) continue;
      // One company's channel failing to open must not stop the others nor publishing.
      await this.open(queue, prefetch).catch(() => log('rabbitmq.consumer_error', { queue }));
    }
  }
  private async open(queue: string, prefetch: number) {
    const consumer = await this.connection!.createChannel();
    try {
      consumer.on('error', () => log('rabbitmq.consumer_error', { queue }));
      consumer.on('close', () => {
        if (this.consumers.get(queue) === consumer) this.consumers.delete(queue);
      });
      await this.ensure(queue);
      await consumer.prefetch(prefetch);
      await consumer.consume(
        queue,
        (msg) => {
          if (msg)
            void this.handler!(msg, consumer).catch(async () => {
              log('worker.infrastructure_failure');
              await consumer.close().catch(() => {});
            });
        },
        { noAck: false },
      );
      this.consumers.set(queue, consumer);
    } catch (error) {
      await consumer.close().catch(() => {});
      throw error;
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.connect();
      await this.db.transaction(async (em) => {
        const rows = await em.query(
          `SELECT o.id, t.id AS "taskId", t."issueId", t."tenantId", CASE WHEN o."revisionId" IS NULL THEN t.type ELSE 'REVISE' END AS type, t.provider, o."revisionId" FROM outbox o JOIN tasks t ON t.id=o."taskId" WHERE o."publishedAt" IS NULL AND o."availableAt"<=now() ORDER BY o."availableAt" LIMIT 20 FOR UPDATE OF o SKIP LOCKED`,
        );
        for (const row of rows) {
          const { id, tenantId, ...message } = row;
          const queue = queueOf(tenantId);
          await this.ensure(queue);
          await new Promise<void>((resolve, reject) =>
            this.publisher!.sendToQueue(
              queue,
              Buffer.from(JSON.stringify(message)),
              { persistent: true, contentType: 'application/json', messageId: id },
              (err) => (err ? reject(err) : resolve()),
            ),
          );
          await em.query(`UPDATE outbox SET "publishedAt"=now() WHERE id=$1`, [id]);
          log('task.published', { taskId: row.taskId, issueId: row.issueId });
        }
      });
    } catch {
      log('messaging.retry_pending');
    } finally {
      this.busy = false;
    }
  }
}
