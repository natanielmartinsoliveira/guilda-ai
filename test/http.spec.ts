import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac } from 'node:crypto';
import { WebhookController } from '../src/webhooks/webhook.controller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { event } from './db';
@Module({
  controllers: [WebhookController],
  providers: [
    {
      provide: OrchestratorService,
      useValue: { accept: async () => ({ id: 'task-http', status: 'PENDING' }) },
    },
  ],
})
class TestModule {}
test('HTTP endpoint retains raw body and validates HMAC before returning 202', async () => {
  const app = await NestFactory.create(TestModule, { rawBody: true, logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const url = await app.getUrl(),
      body = JSON.stringify(event, null, 2),
      signature =
        'sha256=' +
        createHmac('sha256', process.env.ACME_WEBHOOK_SECRET!).update(body).digest('hex');
    const r = await fetch(url + '/webhooks/acme/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-hub-signature-256': signature,
      },
      body,
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ taskId: 'task-http', status: 'PENDING' });
    const bad = await fetch(url + '/webhooks/acme/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-hub-signature-256': signature,
      },
      body: body + ' ',
    });
    expect(bad.status).toBe(401);
  } finally {
    await app.close();
  }
});
