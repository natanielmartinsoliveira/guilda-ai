import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { validSignature } from '../webhooks/signature';
import { GithubIssuesSource, Tenant, TenantSource } from '../tenants/tenants';
import { WebhookRequest, WebhookResult } from './task-source';
export const issueEvent = z.object({
  action: z.literal('opened'),
  repository: z.object({
    name: z.string().min(1),
    full_name: z.string().min(1),
    default_branch: z.string().min(1).max(200),
    owner: z.object({ login: z.string().min(1) }),
  }),
  issue: z.object({
    id: z.number().int().positive().safe(),
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    body: z.string().max(100000).nullable(),
    state: z.literal('open'),
    html_url: z.string().url(),
    author_association: z.string(),
    pull_request: z.unknown().optional(),
  }),
});
export type IssueEvent = z.infer<typeof issueEvent>;
const repositoryShape = issueEvent.shape.repository;
export const commentEvent = z.object({
  action: z.literal('created'),
  repository: repositoryShape,
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
  comment: z.object({
    id: z.number().int().positive().safe(),
    body: z.string().max(65536),
    author_association: z.string(),
    user: z.object({ login: z.string(), type: z.string() }),
  }),
});
/** A submitted review; only "changes requested" asks for work. */
export const reviewEvent = z.object({
  action: z.literal('submitted'),
  repository: repositoryShape,
  pull_request: z.object({ number: z.number().int().positive() }),
  review: z.object({
    id: z.number().int().positive().safe(),
    body: z.string().max(65536).nullish(),
    state: z.string(),
    author_association: z.string(),
    user: z.object({ login: z.string(), type: z.string() }),
  }),
});
/** "/ai <instructions>" at the start of a comment; anything else is conversation. */
const command = /^\s*\/ai(?:\s+([\s\S]*\S))?\s*$/i;
function allowedProject(tenant: Tenant, repository: z.infer<typeof repositoryShape>) {
  const fullName = repository.full_name.toLowerCase();
  // Only repositories this tenant declares, hosted on GitHub, can receive work.
  const project = tenant.projects.find(
    (p) =>
      p.repository.toLowerCase() === fullName &&
      tenant.hosts.find((h) => h.id === p.host)?.type === 'github',
  );
  if (!project || fullName !== `${repository.owner.login}/${repository.name}`.toLowerCase())
    throw new ForbiddenException('Repository not allowed');
  return project;
}
export function githubIssuesWebhook(
  tenant: Tenant,
  source: TenantSource,
  req: WebhookRequest,
): WebhookResult {
  if (source.type !== 'github-issues') throw new NotFoundException();
  if (
    !req.rawBody ||
    !validSignature(req.rawBody, req.header('x-hub-signature-256'), source.webhookSecret)
  )
    throw new UnauthorizedException('Invalid signature');
  // A form-encoded webhook would otherwise look like an event without "action" and be
  // silently ignored; say what to fix instead (visible in GitHub's Recent Deliveries).
  if (!/^application\/json\b/i.test(req.header('content-type') ?? 'application/json'))
    throw new BadRequestException('Set the webhook Content type to application/json');
  const event = req.header('x-github-event');
  const body = req.body as { action?: unknown } | undefined;
  if (event === 'issue_comment' && body?.action === 'created') return revision(tenant, source, req);
  if (event === 'pull_request_review' && body?.action === 'submitted')
    return reviewRevision(tenant, source, req);
  if (event !== 'issues' || body?.action !== 'opened' || !source.createFromIssues)
    return { ignored: true };
  const parsed = issueEvent.safeParse(req.body);
  if (!parsed.success) throw new BadRequestException('Invalid issue payload');
  const { repository, issue } = parsed.data;
  const project = allowedProject(tenant, repository);
  if (!source.allowedAssociations.includes(issue.author_association))
    throw new ForbiddenException('Issue author not allowed');
  if (issue.pull_request) return { ignored: true };
  return {
    item: {
      source: source.id,
      externalId: String(issue.id),
      key: `#${issue.number}`,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.html_url,
      project: project.id,
      closingRef: `Closes #${issue.number}`,
    },
  };
}
/**
 * "Request changes" on a pull request: the review text now, its comments on lines of code
 * fetched by the controller. Approvals and plain comments never trigger work.
 */
function reviewRevision(
  tenant: Tenant,
  source: GithubIssuesSource,
  req: WebhookRequest,
): WebhookResult {
  const parsed = reviewEvent.safeParse(req.body);
  if (!parsed.success) throw new BadRequestException('Invalid review payload');
  const { repository, pull_request, review } = parsed.data;
  if (review.state.toLowerCase() !== 'changes_requested' || review.user.type === 'Bot')
    return { ignored: true };
  allowedProject(tenant, repository);
  if (!source.allowedAssociations.includes(review.author_association))
    throw new ForbiddenException('Review author not allowed');
  return {
    revision: {
      repository: repository.full_name,
      prNumber: pull_request.number,
      instructions: review.body?.trim() ?? '',
      requestedBy: review.user.login,
      externalId: `github-review:${review.id}`,
      review: { id: review.id },
    },
  };
}
function revision(tenant: Tenant, source: GithubIssuesSource, req: WebhookRequest): WebhookResult {
  const parsed = commentEvent.safeParse(req.body);
  if (!parsed.success) throw new BadRequestException('Invalid comment payload');
  const { repository, issue, comment } = parsed.data;
  const match = command.exec(comment.body);
  // Plain conversation, issue (not PR) comments and bots (including our own) never trigger.
  if (!match || !issue.pull_request || comment.user.type === 'Bot') return { ignored: true };
  allowedProject(tenant, repository);
  if (!source.allowedAssociations.includes(comment.author_association))
    throw new ForbiddenException('Comment author not allowed');
  if (!match[1]) return { ignored: true, reason: 'Empty /ai command' };
  return {
    revision: {
      repository: repository.full_name,
      prNumber: issue.number,
      instructions: match[1],
      requestedBy: comment.user.login,
      externalId: `github-comment:${comment.id}`,
    },
  };
}
