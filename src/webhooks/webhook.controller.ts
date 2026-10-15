import {
  Controller,
  Post,
  Req,
  Param,
  HttpCode,
  NotFoundException,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { findTenant, Tenant } from '../tenants/tenants';
import { createHost } from '../tenants/tenant-registry.service';
import { GithubHost } from '../hosts/github.host';
import { ReviewComment } from '../hosts/code-host';
import { githubIssuesWebhook } from '../sources/github-issues.source';
import { bitbucketWebhook } from '../sources/bitbucket.source';
import { WebhookHandler } from '../sources/task-source';
import { OrchestratorService, RevisionRejected } from '../tasks/orchestrator.service';
const handlers: Record<string, WebhookHandler> = {
  'github-issues': githubIssuesWebhook,
  bitbucket: bitbucketWebhook,
};
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly orchestrator: OrchestratorService) {}
  @Post(':tenant/:source')
  @HttpCode(202)
  async receive(
    @Param('tenant') tenantId: string,
    @Param('source') sourceId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const tenant = findTenant(tenantId),
      source = tenant?.sources.find((s) => s.id === sourceId),
      handler = source && handlers[source.type];
    // Same answer for unknown tenant and source: do not reveal which tenants exist.
    if (!tenant || !source || !handler) throw new NotFoundException();
    const result = handler(tenant, source, {
      rawBody: req.rawBody,
      body: req.body,
      header: (name) => req.get(name),
    });
    if ('ignored' in result) return result;
    if ('revision' in result) {
      const { repository, prNumber, review, ...request } = result.revision;
      if (review) {
        // A failure here fails the delivery (visible, redeliverable in GitHub) instead of
        // queueing half of what the reviewer asked.
        const lines = await this.reviewComments(tenant, repository, prNumber, review.id);
        const where = (c: ReviewComment) =>
          c.path ? ` em \`${c.path}\`${c.line ? `, linha ${c.line}` : ''}` : '';
        request.instructions = [
          request.instructions && `Comentário geral da revisão:\n${request.instructions}`,
          lines.length &&
            `Comentários nas linhas do código:\n${lines
              .map(
                (c) =>
                  `- ${c.reply ? '↳ resposta de ' : ''}${c.author}${where(c)}: ${c.body.trim()}`,
              )
              .join('\n')}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        if (!request.instructions)
          return { ignored: true, reason: 'Review requested changes without any comment' };
      }
      try {
        const revision = await this.orchestrator.requestRevision(
          tenant.id,
          { repository, prNumber },
          {
            ...request,
            origin:
              source.type === 'bitbucket'
                ? 'bitbucket-comment'
                : review
                  ? 'github-review'
                  : 'github-comment',
          },
        );
        return { revisionId: revision.id, number: revision.number, status: revision.status };
      } catch (error) {
        // "/ai" on a PR that is not ours, not finished or over the limit: acknowledged, not
        // retried by GitHub; the reason is visible in the delivery log.
        if (error instanceof RevisionRejected) return { ignored: true, reason: error.message };
        throw error;
      }
    }
    const task = await this.orchestrator.accept(tenant.id, result.item);
    return { taskId: task.id, status: task.status };
  }
  /** Overridable in tests. */
  protected async reviewComments(
    tenant: Tenant,
    repository: string,
    prNumber: number,
    reviewId: number,
  ): Promise<ReviewComment[]> {
    const project = tenant.projects.find(
      (p) => p.repository.toLowerCase() === repository.toLowerCase(),
    );
    const host = project && tenant.hosts.find((h) => h.id === project.host);
    if (!host || host.type !== 'github') throw new NotFoundException();
    return (createHost(host) as GithubHost).reviewComments(project.repository, prNumber, reviewId);
  }
}
