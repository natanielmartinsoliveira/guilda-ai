import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { WebhookController } from './webhook.controller';
@Module({ imports: [TasksModule], controllers: [WebhookController] })
export class WebhooksModule {}
