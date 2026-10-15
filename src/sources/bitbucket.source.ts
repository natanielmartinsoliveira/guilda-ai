import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { validSignature } from '../webhooks/signature';
import { Tenant, TenantSource } from '../tenants/tenants';
import { WebhookRequest, WebhookResult } from './task-source';
export const bitbucketCommentEvent = z.object({
  repository: z.object({ full_name: z.string().min(3) }),
  pullrequest: z.object({ id: z.number().int().positive() }),
  comment: z.object({
    id: z.number().int().positive().safe(),
    content: z.object({ raw: z.string().max(65536) }),
    user: z
      .object({
        account_id: z.string().optional(),
        nickname: z.string().optional(),
        display_name: z.string().optional(),
        type: z.string().optional(),
      })
      .optional(),
    /** Present on comments made on a line of the diff. */
    inline: z
      .object({
        path: z.string(),
        to: z.number().int().nullable().optional(),
        from: z.number().int().nullable().optional(),
      })
      .nullish(),
    deleted: z.boolean().optional(),
  }),
});
/** "/ai <instructions>" at the start of the comment; anything else is conversation. */
const command = /^\s*\/ai(?:\s+([\s\S]*\S))?\s*$/i;
/** Bitbucket Cloud webhook: "/ai ..." comments on pull requests become revisions. */
export function bitbucketWebhook(
  tenant: Tenant,
  source: TenantSource,
  req: WebhookRequest,
): WebhookResult {
  if (source.type !== 'bitbucket') throw new NotFoundException();
  // Bitbucket signs like GitHub: X-Hub-Signature: sha256=<hmac of the raw body>.
  if (
    !req.rawBody ||
    !validSignature(req.rawBody, req.header('x-hub-signature'), source.webhookSecret)
  )
    throw new UnauthorizedException('Invalid signature');
  if (req.header('x-event-key') !== 'pullrequest:comment_created') return { ignored: true };
  const parsed = bitbucketCommentEvent.safeParse(req.body);
  if (!parsed.success) throw new BadRequestException('Invalid comment payload');
  const { repository, pullrequest, comment } = parsed.data;
  const match = command.exec(comment.content.raw);
  if (!match || comment.deleted) return { ignored: true };
  const fullName = repository.full_name.toLowerCase();
  const project = tenant.projects.find(
    (p) =>
      p.repository.toLowerCase() === fullName &&
      tenant.hosts.find((h) => h.id === p.host)?.type === 'bitbucket',
  );
  if (!project) throw new ForbiddenException('Repository not allowed');
  const user = comment.user ?? {};
  if (
    source.allowedUsers.length &&
    !source.allowedUsers.some((u) => u === user.account_id || u === user.nickname)
  )
    throw new ForbiddenException('Comment author not allowed');
  if (!match[1]) return { ignored: true, reason: 'Empty /ai command' };
  const line = comment.inline?.to ?? comment.inline?.from;
  const where = comment.inline
    ? `Comentário no arquivo ${comment.inline.path}${line ? `, linha ${line}` : ''}:\n`
    : '';
  return {
    revision: {
      repository: repository.full_name,
      prNumber: pullrequest.id,
      instructions: `${where}${match[1]}`,
      requestedBy: user.nickname ?? user.display_name ?? user.account_id ?? 'bitbucket',
      externalId: `bitbucket-comment:${comment.id}`,
    },
  };
}
