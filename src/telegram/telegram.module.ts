import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TelegramService } from './telegram.service';
@Module({ imports: [TasksModule], providers: [TelegramService] })
export class TelegramModule {}
