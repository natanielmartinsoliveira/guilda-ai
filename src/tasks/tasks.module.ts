import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { OrchestratorService } from './orchestrator.service';
@Module({
  imports: [TenantsModule],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class TasksModule {}
