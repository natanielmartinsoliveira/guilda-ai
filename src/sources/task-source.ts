import { Attachment } from '../attachments/attachments';
import type { IssueMeta, StepPlan } from '../database/entities';
import { Tenant, TenantSource } from '../tenants/tenants';
/** A unit of work normalized from any tracker (GitHub Issues, Jira, Notion, API...). */
export interface WorkItem {
  /** Source id in the tenant configuration. */
  source: string;
  externalId: string;
  /** Human reference shown in commits and PRs: "#7", "API-123". */
  key: string;
  title: string;
  body: string;
  url: string;
  /** Project id in the tenant configuration that holds the code. */
  project: string;
  /** Line that makes the code host close the item on merge, when it can. */
  closingRef?: string;
  /** Files already stored in attachmentsDir(tenant, source, externalId). */
  attachments?: Attachment[];
  /** Ordered sub-tasks delivered as one PR (first one by the task, the rest as revisions). */
  steps?: StepPlan[];
  /** Branch flow overrides (stacked sub-task branches): start point, PR target, story. */
  delivery?: Pick<
    IssueMeta,
    'baseRef' | 'prTarget' | 'ensureBase' | 'story' | 'stepIndex' | 'single' | 'route'
  >;
}
export interface WebhookRequest {
  rawBody?: Buffer;
  body: unknown;
  header(name: string): string | undefined;
}
/** A "/ai ..." comment on a pull request: a revision of the task that opened it. */
export interface RevisionTrigger {
  repository: string;
  prNumber: number;
  instructions: string;
  requestedBy: string;
  externalId: string;
  /** A GitHub review ("Request changes"): its line comments are fetched before queueing. */
  review?: { id: number };
}
export type WebhookResult =
  { item: WorkItem } | { revision: RevisionTrigger } | { ignored: true; reason?: string };
/** Validates authenticity and scope, then normalizes. Throws HTTP exceptions on rejection. */
export type WebhookHandler = (
  tenant: Tenant,
  source: TenantSource,
  request: WebhookRequest,
) => WebhookResult;
