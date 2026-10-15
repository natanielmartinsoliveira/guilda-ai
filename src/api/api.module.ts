import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TasksController } from './tasks.controller';
import { WebModule } from '../web/web.module';
import { SourcesModule } from '../sources/sources.module';
@Module({ imports: [TasksModule, WebModule, SourcesModule], controllers: [TasksController] })
export class ApiModule {}
