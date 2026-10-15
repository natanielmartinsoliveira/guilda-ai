import { DesignService } from './design/design.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { MessagingModule } from './messaging/messaging.module';
import { AgentsModule } from './agents/agents.module';
import { TenantsModule } from './tenants/tenants.module';
import { GitService } from './git/git.service';
import { ChecksService } from './checks/checks.service';
import { TaskWorkerService } from './tasks/task-worker.service';
import { SourceReporter } from './sources/source-reporter.service';
import { OrchestratorService } from './tasks/orchestrator.service';
import { TaskWorkspaces } from './workspaces/task-workspaces.service';
@Module({
  imports: [DatabaseModule, MessagingModule, AgentsModule, TenantsModule],
  // SourceReporter only: pollers belong to the API process, never to workers.
  // OrchestratorService queues the next sub-task step after each one lands.
  providers: [
    GitService,
    ChecksService,
    TaskWorkerService,
    SourceReporter,
    OrchestratorService,
    DesignService,
    // One registry for the git service and the worker: the task's workspace binding is shared.
    TaskWorkspaces,
  ],
})
export class WorkerModule {}
