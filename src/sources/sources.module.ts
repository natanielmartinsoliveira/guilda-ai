import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { JiraPoller } from './jira/jira.poller';
import { SourceReporter } from './source-reporter.service';
import { GitlabReviewPoller } from './gitlab-review.poller';
import { BusinessmapPoller } from './businessmap/businessmap.poller';
import { CardStarters } from './card-starters';
@Module({
  imports: [TasksModule],
  providers: [JiraPoller, SourceReporter, GitlabReviewPoller, BusinessmapPoller, CardStarters],
  exports: [SourceReporter, JiraPoller, CardStarters],
})
export class SourcesModule {}
