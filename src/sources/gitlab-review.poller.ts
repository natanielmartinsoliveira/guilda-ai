import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config, log } from '../config';
import { Issue, Project, PullRequest, Task } from '../database/entities';
import { GitlabHost } from '../hosts/gitlab.host';
import { OrchestratorService, RevisionRejected } from '../tasks/orchestrator.service';
import { Tenant, tenants, TenantHost } from '../tenants/tenants';
/** "/ai <instructions>" at the start of the comment; anything else is conversation. */
const command = /^\s*\/ai(?:\s+([\s\S]*\S))?\s*$/i;
type GitlabConfig = Extract<TenantHost, { type: 'gitlab' }>;
/**
 * Reads the open merge requests of GitLab hosts for "/ai ..." comments: a company's GitLab
 * cannot reach the AI Dev Team, so revisions are asked for by polling, like Jira.
 */
@Injectable()
export class GitlabReviewPoller implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  constructor(
    private readonly db: DataSource,
    private readonly orchestrator: OrchestratorService,
  ) {}
  /** Overridable in tests. */
  protected gitlab(host: GitlabConfig) {
    return new GitlabHost(host.id, host);
  }
  onModuleInit() {
    if (!config().SOURCE_POLLING) return;
    for (const tenant of tenants()) {
      const hosts = tenant.hosts.filter((h): h is GitlabConfig => h.type === 'gitlab');
      if (!hosts.length) continue;
      const seconds = Math.min(...hosts.map((h) => h.pollSeconds));
      void this.poll(tenant);
      this.timers.push(setInterval(() => void this.poll(tenant), seconds * 1000));
    }
  }
  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }
  async poll(tenant: Tenant) {
    // One pass at a time per company: a slow GitLab must not stack polls.
    if (this.running.has(tenant.id)) return;
    this.running.add(tenant.id);
    try {
      for (const host of tenant.hosts)
        if (host.type === 'gitlab') await this.pollHost(tenant, host);
    } finally {
      this.running.delete(tenant.id);
    }
  }
  private async pollHost(tenant: Tenant, cfg: GitlabConfig) {
    const gitlab = this.gitlab(cfg);
    const prs = await this.db.getRepository(PullRequest).findBy({ host: cfg.id, state: 'opened' });
    for (const pr of prs) {
      try {
        const task = await this.db
          .getRepository(Task)
          .findOneBy({ id: pr.taskId, tenantId: tenant.id });
        if (!task) continue;
        const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
        const project = await this.db
          .getRepository(Project)
          .findOneByOrFail({ id: issue.projectId });
        const repository = tenant.projects.find((p) => p.id === project.key)?.repository;
        if (!repository) continue;
        const state = await gitlab.mergeRequestState(repository, pr.number);
        if (state !== 'opened') {
          await this.db.getRepository(PullRequest).update(pr.id, { state });
          continue;
        }
        const since = issue.meta?.gitlabCommentsAt;
        const comments = await gitlab.pullRequestComments(repository, pr.number, since);
        for (const c of comments) {
          const match = command.exec(c.body);
          if (!match?.[1]) continue;
          if (cfg.allowedUsers.length && !cfg.allowedUsers.includes(c.authorId ?? '')) continue;
          const where = c.path
            ? `Comentário no arquivo ${c.path}${c.line ? `, linha ${c.line}` : ''}:\n`
            : '';
          try {
            await this.orchestrator.requestRevision(
              tenant.id,
              { taskId: task.id },
              {
                instructions: `${where}${match[1]}`,
                origin: 'gitlab-comment',
                requestedBy: c.authorId ?? c.author,
                externalId: `gitlab-note:${c.id}`,
              },
            );
          } catch (error) {
            if (!(error instanceof RevisionRejected)) throw error;
            log('gitlab.revision_rejected', {
              tenant: tenant.id,
              taskId: task.id,
              reason: error.message,
            });
          }
        }
        if (comments.length) {
          issue.meta = { ...(issue.meta ?? {}), gitlabCommentsAt: comments.at(-1)!.createdAt };
          await this.db.getRepository(Issue).save(issue);
        }
      } catch (error) {
        // One MR's trouble (network, VPN) never stops the others; the next poll retries.
        log('gitlab.poll_failed', {
          tenant: tenant.id,
          pr: pr.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
