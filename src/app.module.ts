import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { MessagingModule } from './messaging/messaging.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ApiModule } from './api/api.module';
import { SourcesModule } from './sources/sources.module';
import { TelegramModule } from './telegram/telegram.module';
import { WebModule } from './web/web.module';
@Module({
  imports: [
    DatabaseModule,
    MessagingModule,
    WebhooksModule,
    ApiModule,
    SourcesModule,
    TelegramModule,
    WebModule,
  ],
})
export class AppModule {}
