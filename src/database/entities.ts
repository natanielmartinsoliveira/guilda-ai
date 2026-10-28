import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import type { Attachment } from '../attachments/attachments';
import type { RunUsage } from '../agents/agent.types';
/** One sub-task of a delivery: step 0 is the task itself, later steps become revisions. */
export interface StepPlan {
  externalId: string;
  key: string;
  title: string;
  body: string;
  /** Pre-generated so the step's files can be stored before its revision exists. */
  revisionId: string;
  attachments: Attachment[];
}
/** A story whose sub-tasks each get a stacked branch and a PR into the story branch. */
export interface StoryPlan {
  key: string;
  externalId: string;
  title: string;
  body: string;
  /** Story branch (PR target of every sub-task). */
  branch: string;
  steps: StepPlan[];
}
/** A question the AI asked instead of guessing; options are suggestions, not limits. */
export interface DecisionQuestion {
  text: string;
  options?: string[];
}
/** Operator input that applies to every later prompt of the task (and its revisions). */
export interface Clarification {
  kind: 'answer' | 'instruction';
  question?: string;
  text: string;
  /** ISO time. */
  at: string;
}
export interface IssueMeta {
  steps?: StepPlan[];
  /** Newest tracker comment already turned into a revision (change requests). */
  lastCommentId?: string;
  /** Newest pull request comment (ISO time) already turned into a revision. */
  lastPrCommentAt?: string;
  /** Newest GitLab MR comment already read for "/ai" (GitlabReviewPoller). */
  gitlabCommentsAt?: string;
  /** Branch the task starts from (default: the project's default branch). */
  baseRef?: string;
  /** Branch the PR targets (default: the project's default branch). */
  prTarget?: string;
  /** Created from the default branch when missing (a story branch). */
  ensureBase?: boolean;
  /** branch-per-subtask: the story and this task's position in it. */
  story?: StoryPlan;
  stepIndex?: number;
  /** One sub-task started on its own: it neither queues the next one nor closes the story. */
  single?: boolean;
  /** Route of the project's method, chosen by the operator (never inferred). */
  route?: string;
}
export type Status = 'PENDING' | 'RUNNING' | 'WAITING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type Provider = 'codex' | 'claude' | 'openrouter' | 'gemini';
export abstract class Base {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
@Entity('projects')
@Index(['tenantId', 'key'], { unique: true })
export class Project extends Base {
  @Column() tenantId!: string;
  /** Project id in the tenant configuration. */
  @Column() key!: string;
  @Column() host!: string;
  @Column() name!: string;
  @Column() owner!: string;
  @Column() repository!: string;
  @Column() defaultBranch!: string;
  @Column() localPath!: string;
}
@Entity('issues')
@Index(['tenantId', 'source', 'externalId'], { unique: true })
export class Issue extends Base {
  @Column() tenantId!: string;
  /** Source id in the tenant configuration. */
  @Column() source!: string;
  @Column() externalId!: string;
  /** Human reference: "#7", "API-123". */
  @Column() externalKey!: string;
  @Column({ type: 'varchar', nullable: true }) closingRef!: string | null;
  @Column({ type: 'jsonb', nullable: true }) attachments!: Attachment[] | null;
  /** Source-specific state: the ordered sub-task plan, last processed review comment. */
  @Column({ type: 'jsonb', nullable: true }) meta!: IssueMeta | null;
  @Column() title!: string;
  @Column('text') body!: string;
  @Column() state!: string;
  @Column() repository!: string;
  @Column() url!: string;
  @Column('uuid') projectId!: string;
}
@Entity('tasks')
@Index(['issueId', 'createdAt'])
export class Task extends Base {
  @Column() tenantId!: string;
  /** A card's tasks: one at a time; the operator may restart a card whose last published nothing. */
  @Column('uuid') issueId!: string;
  @Column({ default: 'CODE' }) type!: string;
  @Column({ default: 'PENDING' }) status!: Status;
  @Column({ default: 'codex' }) provider!: Provider;
  @Column() branch!: string;
  @Column() workspace!: string;
  @Column('text') instructions!: string;
  @Column({ type: 'jsonb', nullable: true }) result!: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ default: 0 }) attempts!: number;
  @Column({ default: 'QUEUED' }) stage!: string;
  /**
   * What its AI runs cost, as the providers report it (kept across retries and answers). Only
   * AgentRouter writes it, in SQL: a save of a task loaded before a run must not undo the run's.
   */
  @Column({ type: 'double precision', default: 0, update: false }) costUsd!: number;
  /** Tokens, turns and agent time of its AI runs, summed like costUsd (same rule). */
  @Column({ type: 'jsonb', nullable: true, update: false }) usage!: RunUsage | null;
}
@Entity('agent_runs')
export class AgentRun {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') taskId!: string;
  @Column() agent!: string;
  @Column() provider!: string;
  @Column() status!: string;
  @Column('text') command!: string;
  @Column({ type: 'text', default: '' }) stdout!: string;
  @Column({ type: 'text', default: '' }) stderr!: string;
  @Column({ type: 'integer', nullable: true }) exitCode!: number | null;
  @Column({ type: 'timestamptz' }) startedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt!: Date | null;
  /** An AI run's tokens, turns and time, as its provider reported them. */
  @Column({ type: 'jsonb', nullable: true }) usage!: RunUsage | null;
  /** The method phase it ran in (spec, gate, deliver…). */
  @Column({ type: 'varchar', nullable: true }) phase!: string | null;
}
@Entity('pull_requests')
export class PullRequest extends Base {
  @Column({ type: 'uuid', unique: true }) taskId!: string;
  /** Host id in the tenant configuration. */
  @Column() host!: string;
  @Column() externalId!: string;
  @Column('integer') number!: number;
  @Column() title!: string;
  @Column() url!: string;
  @Column() branch!: string;
  @Column() baseBranch!: string;
  @Column() state!: string;
}
@Entity('outbox')
export class Outbox extends Base {
  @Column('uuid') taskId!: string;
  /** Set when the delivery is a revision of the task rather than the task itself. */
  @Column({ type: 'uuid', nullable: true }) revisionId!: string | null;
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' }) availableAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) publishedAt!: Date | null;
}
/**
 * A follow-up change on a task's pull request ("/ai adjust X"). Built on top of the PR
 * branch head, pushed as a new commit. Same status/attempt semantics as Task.
 */
@Entity('revisions')
@Index(['taskId', 'number'], { unique: true })
@Index(['taskId', 'externalId'], { unique: true })
export class Revision extends Base {
  @Column('uuid') taskId!: string;
  @Column('integer') number!: number;
  @Column('text') instructions!: string;
  /** "github-comment", "bitbucket-comment", "api", "jira-subtask" or "jira-change-request". */
  @Column() origin!: string;
  /** Tracker card this revision implements (sub-task steps), e.g. "PF-24276". */
  @Column({ type: 'varchar', nullable: true }) externalKey!: string | null;
  @Column({ type: 'varchar', nullable: true }) title!: string | null;
  @Column({ type: 'varchar', nullable: true }) requestedBy!: string | null;
  /** Deduplicates redelivered triggers, e.g. the same PR comment. */
  @Column({ type: 'varchar', nullable: true }) externalId!: string | null;
  @Column({ type: 'jsonb', nullable: true }) attachments!: Attachment[] | null;
  @Column({ default: 'PENDING' }) status!: Status;
  @Column({ default: 'QUEUED' }) stage!: string;
  @Column({ default: 0 }) attempts!: number;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'jsonb', nullable: true }) result!: Record<string, unknown> | null;
  @Column({ type: 'varchar', nullable: true }) provider!: Provider | null;
}
/** Capacity state of an AI credential, shared by all tasks of the tenant. */
@Entity('ai_credential_states')
export class CredentialState {
  @PrimaryColumn() tenantId!: string;
  @PrimaryColumn() credentialId!: string;
  @Column({ type: 'timestamptz' }) unavailableUntil!: Date;
  @Column() reason!: string;
  @Column({ type: 'text', default: '' }) lastError!: string;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
/**
 * Something only the operator can settle: a question the AI asked instead of guessing
 * (the job is WAITING), or a final failure (the job is FAILED).
 */
@Entity('decisions')
@Index(['tenantId', 'status'])
export class Decision extends Base {
  @Column() tenantId!: string;
  @Column('uuid') taskId!: string;
  @Column({ type: 'uuid', nullable: true }) revisionId!: string | null;
  @Column() type!: 'question' | 'failure';
  @Column({ default: 'open' }) status!: 'open' | 'answered';
  @Column({ type: 'jsonb', nullable: true }) questions!: DecisionQuestion[] | null;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  @Column({ type: 'text', nullable: true }) details!: string | null;
  @Column({ type: 'jsonb', nullable: true }) answer!: Record<string, unknown> | null;
  /** "web", "telegram" or "api". */
  @Column({ type: 'varchar', nullable: true }) answeredVia!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) answeredAt!: Date | null;
}
/** A message for the operator (Telegram), sent and retried by the API process. */
@Entity('notifications')
@Index(['status', 'availableAt'])
export class Notification extends Base {
  @Column() kind!: 'decision' | 'pr' | 'text';
  @Column({ type: 'uuid', nullable: true }) decisionId!: string | null;
  @Column({ type: 'jsonb', nullable: true }) payload!: Record<string, unknown> | null;
  @Column({ default: 'pending' }) status!: 'pending' | 'sent' | 'failed';
  @Column({ default: 0 }) attempts!: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) availableAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) sentAt!: Date | null;
  /** Telegram message id, to edit the message after a button click. */
  @Column({ type: 'varchar', nullable: true }) messageId!: string | null;
  @Column({ type: 'text', nullable: true }) lastError!: string | null;
}
/** A pending front login: the password was right, the Telegram code is awaited. */
@Entity('web_logins')
export class WebLogin extends Base {
  @Column() codeHash!: string;
  @Column({ type: 'timestamptz' }) expiresAt!: Date;
  @Column({ default: 0 }) attempts!: number;
  @Column({ type: 'timestamptz', nullable: true }) usedAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) ip!: string | null;
}
/** A front session; the cookie holds the token, the database only its hash. */
@Entity('web_sessions')
export class WebSession extends Base {
  @Index({ unique: true }) @Column() tokenHash!: string;
  /** Fingerprint of the password hash it was opened with (a new password ends it). */
  @Column({ type: 'varchar', nullable: true }) passwordTag!: string | null;
  @Column({ type: 'timestamptz' }) expiresAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) ip!: string | null;
  @Column({ type: 'varchar', nullable: true }) userAgent!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastSeenAt!: Date | null;
}
/**
 * A lesson the system noticed on a project (a stop the operator answered, a failure that keeps
 * coming back), waiting for the operator to save it into the pack or dismiss it.
 */
@Entity('lesson_suggestions')
@Index(['tenantId', 'projectKey', 'signature'], { unique: true })
export class LessonSuggestion extends Base {
  @Column() tenantId!: string;
  @Column() projectKey!: string;
  /** The problem with what changes from task to task (ids, numbers, paths) taken out. */
  @Column() signature!: string;
  @Column('text') problem!: string;
  /** How the operator answered it last (a stop's answer; none for a bare failure). */
  @Column({ type: 'text', nullable: true }) answer!: string | null;
  @Column({ type: 'integer', default: 1 }) count!: number;
  @Column({ type: 'jsonb', default: () => "'[]'" }) taskIds!: string[];
  @Column({ default: 'open' }) status!: 'open' | 'saved' | 'dismissed';
}
export const entities = [
  Project,
  Issue,
  Task,
  Revision,
  AgentRun,
  PullRequest,
  Outbox,
  CredentialState,
  Decision,
  Notification,
  WebLogin,
  WebSession,
  LessonSuggestion,
];
