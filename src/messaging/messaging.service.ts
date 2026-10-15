import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as amqp from 'amqplib';
import { config, log } from '../config';
export const QUEUE = 'ai-dev-tasks';
@Injectable()
export class MessagingService implements OnModuleInit, OnModuleDestroy {
  private connection?: amqp.ChannelModel;
  private publisher?: amqp.ConfirmChannel;
  private consumer?: amqp.Channel;
  private handler?: (message: amqp.ConsumeMessage, channel: amqp.Channel) => Promise<void>;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  constructor(private readonly db: DataSource) {}
  consume(handler: (message: amqp.ConsumeMessage, channel: amqp.Channel) => Promise<void>) {
    this.handler = handler;
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
  private async connect() {
    if (!this.publisher) {
      if (this.connection) await this.connection.close().catch(() => {});
      const connection = await amqp.connect(config().RABBITMQ_URL, { timeout: 10000 });
      connection.on('error', () => log('rabbitmq.connection_error'));
      connection.on('close', () => {
        this.publisher = undefined;
        this.consumer = undefined;
        this.connection = undefined;
      });
      this.connection = connection;
      const pub = await connection.createConfirmChannel();
      pub.on('error', () => log('rabbitmq.channel_error'));
      pub.on('close', () => {
        this.publisher = undefined;
      });
      await pub.assertQueue(`${QUEUE}.dead`, { durable: true });
      await pub.assertQueue(QUEUE, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': `${QUEUE}.dead` },
      });
      this.publisher = pub;
    }
    if (this.handler && !this.consumer) {
      const consumer = await this.connection!.createChannel();
      consumer.on('error', () => log('rabbitmq.consumer_error'));
      consumer.on('close', () => {
        this.consumer = undefined;
      });
      await consumer.prefetch(1);
      this.consumer = consumer;
      await consumer.consume(
        QUEUE,
        (msg) => {
          if (msg)
            void this.handler!(msg, consumer).catch(async () => {
              log('worker.infrastructure_failure');
              await consumer.close().catch(() => {});
            });
        },
        { noAck: false },
      );
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.connect();
      await this.db.transaction(async (em) => {
        const rows = await em.query(
          `SELECT o.id, t.id AS "taskId", t."issueId", CASE WHEN o."revisionId" IS NULL THEN t.type ELSE 'REVISE' END AS type, t.provider, o."revisionId" FROM outbox o JOIN tasks t ON t.id=o."taskId" WHERE o."publishedAt" IS NULL AND o."availableAt"<=now() ORDER BY o."availableAt" LIMIT 20 FOR UPDATE OF o SKIP LOCKED`,
        );
        for (const row of rows) {
          const { id, ...message } = row;
          await new Promise<void>((resolve, reject) =>
            this.publisher!.sendToQueue(
              QUEUE,
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
