import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, IsNull } from 'typeorm';
import { assertTransition } from './status';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config, log, TaskError, workspace } from '../config';
import { isSafeBranch, renderBranch } from './branch';
import { WorkItem } from '../sources/task-source';
import { TenantRegistry } from '../tenants/tenant-registry.service';
import {
  Project,
  Issue,
  Task,
  Outbox,
  PullRequest,
  Revision,
  StepPlan,
  StoryPlan,
  Decision,
} from '../database/entities';
import { Attachment } from '../attachments/attachments';
import { ProcessRunnerService } from '../agents/process-runner.service';
import { TaskWorkspaces } from '../workspaces/task-workspaces.service';
export type DiscardOutcome = 'discarded' | 'not_found' | 'running' | 'local';
export type RevisionTarget = { taskId: string } | { repository: string; prNumber: number };
export interface RevisionRequest {
  /** Pre-generated when files were stored before the revision exists. */
  id?: string;
  instructions: string;
  origin:
    | 'github-comment'
    | 'github-review'
    | 'bitbucket-comment'
    | 'gitlab-comment'
    | 'api'
    | 'jira-subtask'
    | 'jira-change-request';
  requestedBy?: string;
  externalId?: string;
  externalKey?: string;
  title?: string;
  attachments?: Attachment[];
}
/** Automatic sub-task steps are part of the delivery, not reviewer requests: no limit. */
const COUNTED = (origin: string) => origin !== 'jira-subtask';
export type StepProgress =
  | { state: 'none' }
  | { state: 'queued'; step: StepPlan; index: number }
  | { state: 'waiting' }
  | { state: 'complete'; steps: StepPlan[] };
export class RevisionRejected extends Error {
  constructor(
    public readonly reason: 'not_found' | 'not_ready' | 'limit',
    message: string,
  ) {
    super(message);
  }
}
export class JobRejected extends Error {
  constructor(
    public readonly reason: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}
/** What the operator decided: answers to the AI's questions, or what to do with a failure. */
export type DecisionAnswer =
  | { answers: string[] }
  | { action: 'retry' | 'cancel' }
  | { action: 'retry_with_instructions'; instructions: string };
/** A card's current task: the latest (earlier ones were restarted by the operator). */
export function latestTask(em: Pick<EntityManager, 'findOne'>, issueId: string) {
  return em.findOne(Task, { where: { issueId }, order: { createdAt: 'DESC' } });
}
/**
 * Why a card cannot get a new task now, or undefined when it can: its last task ended and
 * published nothing (a pull request is changed by adjustments, never restarted).
 */
export function restartRefusal(task: Task, hasPullRequest: boolean): string | undefined {
  if (['PENDING', 'RUNNING', 'WAITING'].includes(task.status))
    return 'A tarefa anterior do card ainda está em andamento: termine ou cancele antes de refazer';
  const rehearsal = task.result?.rehearsal as { promoted?: boolean } | undefined;
  if (hasPullRequest || rehearsal?.promoted || task.result?.prUrl)
    return 'O card já tem PR/MR: peça um ajuste ou abra uma correção em vez de refazer';
  return undefined;
}
@Injectable()
export class OrchestratorService {
  constructor(
    private readonly db: DataSource,
    private readonly tenants: TenantRegistry,
  ) {}
  /**
   * Removes a coder task's folder from the company's workspace (a rehearsal the operator
   * checked, or a failed / cancelled attempt). Never while the worker may be using it.
   */
  async discard(tenantId: string, taskId: string): Promise<DiscardOutcome> {
    return this.db.transaction(async (em): Promise<DiscardOutcome> => {
      // The worker holds this lock while it runs the task, even one just cancelled.
      const [{ locked }] = await em.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [taskId],
      );
      const task = await em.findOneBy(Task, { id: taskId, tenantId });
      if (!task) return 'not_found';
      if (!locked || ['PENDING', 'RUNNING', 'WAITING'].includes(task.status)) return 'running';
      const issue = await em.findOneByOrFail(Issue, { id: task.issueId });
      const project = await em.findOneByOrFail(Project, { id: issue.projectId });
      const { project: cfg } = this.tenants.project(tenantId, project.key);
      if (cfg.workspace.type !== 'coder') return 'local';
      await new TaskWorkspaces(new ProcessRunnerService(this.db))
        .create(task, cfg.workspace)
        .destroy();
      const result = { ...(task.result ?? {}) };
      if (result.rehearsal) result.rehearsal = { ...(result.rehearsal as object), discarded: true };
      else result.discarded = true;
      task.result = result;
      await em.save(task);
      return 'discarded';
    });
  }
  /**
   * The card's task: the existing one, or a new one. With `again` (the operator, never a poller)
   * a card whose last task published nothing gets a new task; the earlier one is kept, marked
   * superseded, and its workspace folder is discarded.
   */
  async accept(tenantId: string, item: WorkItem, opts: { again?: boolean } = {}): Promise<Task> {
    let superseded: Task | undefined;
    const task = await this.acceptIn(tenantId, item, !!opts.again, (t) => (superseded = t));
    const done = superseded?.result as
      { discarded?: boolean; rehearsal?: { discarded?: boolean } } | undefined;
    // After the commit: the folder lives in the company's workspace (ssh), never inside the lock.
    if (superseded && !done?.discarded && !done?.rehearsal?.discarded)
      await this.discard(tenantId, superseded.id).catch((error: unknown) =>
        log('task.restart_discard_failed', {
          taskId: superseded!.id,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
    return task;
  }
  private async acceptIn(
    tenantId: string,
    item: WorkItem,
    again: boolean,
    supersede: (previous: Task) => void,
  ): Promise<Task> {
    const { tenant, project: cfg } = this.tenants.project(tenantId, item.project);
    return this.db.transaction(async (em) => {
      // Serializes duplicate deliveries and project upserts across API replicas.
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenant.id}/${cfg.id}`]);
      const existingIssue = await em.findOneBy(Issue, {
        tenantId: tenant.id,
        source: item.source,
        externalId: item.externalId,
      });
      const previous = existingIssue ? await latestTask(em, existingIssue.id) : null;
      if (previous && !again) return previous;
      if (previous) {
        const refusal = restartRefusal(
          previous,
          !!(await em.findOneBy(PullRequest, { taskId: previous.id })),
        );
        if (refusal) throw new TaskError(refusal, false);
      }
      const id = randomUUID();
      // Generated from the project pattern; never the default, a protected branch or the
      // branch this one starts from / merges into.
      const branch = renderBranch(cfg.branch, item.key, id, item.title);
      const off = [...cfg.protectedBranches, cfg.defaultBranch];
      if (
        !isSafeBranch(branch, off) ||
        [item.delivery?.baseRef, item.delivery?.prTarget].includes(branch)
      )
        throw new TaskError(`Branch "${branch}" is invalid or protected for ${cfg.id}`);
      // Start point / PR target may be the default branch itself, otherwise any safe ref.
      for (const ref of [item.delivery?.baseRef, item.delivery?.prTarget])
        if (ref && ref !== cfg.defaultBranch && !isSafeBranch(ref, cfg.protectedBranches))
          throw new TaskError(`Branch "${ref}" is invalid`);
      const meta = {
        ...(item.steps?.length ? { steps: item.steps } : {}),
        ...(item.delivery ?? {}),
      };
      const [owner, repository] = cfg.repository.split('/');
      const project = await em.save(Project, {
        ...(await em.findOneBy(Project, { tenantId: tenant.id, key: cfg.id })),
        tenantId: tenant.id,
        key: cfg.id,
        host: cfg.host,
        name: cfg.repository,
        owner,
        repository,
        defaultBranch: cfg.defaultBranch,
        localPath: resolve(config().WORKSPACE_ROOT, tenant.id),
      });
      const issue = await em.save(Issue, {
        ...existingIssue,
        tenantId: tenant.id,
        source: item.source,
        externalId: item.externalId,
        externalKey: item.key,
        closingRef: item.closingRef ?? null,
        attachments: item.attachments?.length ? item.attachments : null,
        meta: Object.keys(meta).length ? meta : (existingIssue?.meta ?? null),
        title: item.title,
        body: item.body,
        state: 'open',
        repository: cfg.repository,
        url: item.url,
        projectId: project.id,
      });
      const task = await em.save(Task, {
        id,
        tenantId: tenant.id,
        issueId: issue.id,
        type: 'CODE',
        // First choice; the worker records the provider actually used after fallbacks.
        provider: tenant.ai.credentials[0].provider,
        status: 'PENDING',
        branch,
        workspace: workspace(tenant.id, id),
        instructions: `${issue.title}\n\n${issue.body}`,
        attempts: 0,
        stage: 'QUEUED',
      });
      await em.save(Outbox, { taskId: id });
      if (previous) {
        previous.result = { ...(previous.result ?? {}), supersededBy: id };
        await em.save(previous);
        supersede(previous);
      }
      return task;
    });
  }
  /**
   * Locks the task without waiting: the worker holds the same advisory lock while it runs the
   * task or one of its revisions, and an operator action must not race it.
   */
  private async operate<T>(
    tenantId: string,
    taskId: string,
    revisionNumber: number | undefined,
    action: (
      em: EntityManager,
      ctx: { task: Task; job: Task | Revision; entity: typeof Task | typeof Revision },
    ) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (em) => {
      const [{ locked }] = await em.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [taskId],
      );
      if (!locked) throw new JobRejected('conflict', 'The task is running right now; try later');
      const task = await em.findOneBy(Task, { id: taskId, tenantId });
      if (!task) throw new JobRejected('not_found', 'Unknown task');
      if (revisionNumber === undefined) return action(em, { task, job: task, entity: Task });
      const revision = await em.findOneBy(Revision, { taskId, number: revisionNumber });
      if (!revision) throw new JobRejected('not_found', `Unknown revision #${revisionNumber}`);
      return action(em, { task, job: revision, entity: Revision });
    });
  }
  /**
   * Queues a failed or cancelled task (or revision) again, starting over: a task from the
   * current tip of its base branch, a revision from the current head of the PR. Meant for
   * after the cause was fixed (token, configuration, credentials). A task of a method resumes
   * where it stopped instead (its phase, commits and the gate's words are kept).
   */
  retry(tenantId: string, taskId: string, revisionNumber?: number) {
    return this.operate(tenantId, taskId, revisionNumber, async (em, { job, entity }) => {
      if (job.status !== 'FAILED' && job.status !== 'CANCELLED')
        throw new JobRejected(
          'conflict',
          `Only failed or cancelled jobs can be retried (status: ${job.status})`,
        );
      if (entity === Task && (await em.existsBy(PullRequest, { taskId })))
        throw new JobRejected(
          'conflict',
          'The task already has a pull request; request a revision ("/ai ...") instead',
        );
      await this.requeue(em, job, entity, taskId, !!job.result?.method || !!job.result?.promote);
      await this.closeDecisions(em, taskId, entity === Revision ? job.id : null, 'retry');
      return job;
    });
  }
  /**
   * Queues a finished rehearsal again to publish it: the worker commits only the delivery's
   * files on the current base branch, pushes and opens a draft PR (task.result.promote).
   */
  promote(tenantId: string, taskId: string) {
    return this.operate(tenantId, taskId, undefined, async (em, { job, entity }) => {
      const rehearsal = job.result?.rehearsal as
        { promoted?: boolean; discarded?: boolean } | undefined;
      if (job.status !== 'SUCCESS' || !rehearsal || rehearsal.promoted || rehearsal.discarded)
        throw new JobRejected(
          'conflict',
          'Only a finished rehearsal not yet promoted can be promoted',
        );
      if (await em.existsBy(PullRequest, { taskId }))
        throw new JobRejected('conflict', 'The task already has a pull request');
      // The one way a finished task goes back to the queue (assertTransition keeps SUCCESS final
      // for everything else): the checks above are its guard.
      Object.assign(job, {
        status: 'PENDING',
        stage: 'QUEUED',
        attempts: 0,
        error: null,
        result: { ...job.result, promote: true },
      });
      await em.save(entity as EntityTarget<Task | Revision>, job);
      await em.save(Outbox, { taskId, revisionId: null });
      return job;
    });
  }
  /** Cancels a queued, waiting or failed task (or revision); a running one is not killed. */
  cancel(tenantId: string, taskId: string, revisionNumber?: number) {
    return this.operate(tenantId, taskId, revisionNumber, async (em, { job, entity }) => {
      if (!['PENDING', 'WAITING', 'FAILED'].includes(job.status))
        throw new JobRejected(
          'conflict',
          `Only queued, waiting or failed jobs can be cancelled (status: ${job.status})`,
        );
      assertTransition(job.status, 'CANCELLED');
      job.status = 'CANCELLED';
      job.error = 'Cancelled by the operator';
      // Messages already in the queue are dropped by the worker on CANCELLED.
      await em.save(entity as EntityTarget<Task | Revision>, job);
      await this.closeDecisions(em, taskId, entity === Revision ? job.id : null, 'cancel');
      return job;
    });
  }
  /** Back to the queue, starting over (a task from its base branch, a revision from the PR head). */
  private async requeue(
    em: EntityManager,
    job: Task | Revision,
    entity: typeof Task | typeof Revision,
    taskId: string,
    /** Resume instead of starting over: a task of a method keeps its phase and commits. */
    keep = false,
  ) {
    assertTransition(job.status, 'PENDING');
    Object.assign(job, {
      status: 'PENDING',
      stage: 'QUEUED',
      attempts: 0,
      error: null,
      result: keep ? job.result : null,
    });
    await em.save(entity as EntityTarget<Task | Revision>, job);
    await em.save(Outbox, { taskId, revisionId: entity === Revision ? job.id : null });
  }
  /** retry_task / cancel_task settle the job's open decision too. */
  private async closeDecisions(
    em: EntityManager,
    taskId: string,
    revisionId: string | null,
    action: string,
  ) {
    await em.update(
      Decision,
      { taskId, revisionId: revisionId ?? IsNull(), status: 'open' },
      { status: 'answered', answer: { action }, answeredVia: 'api', answeredAt: new Date() },
    );
  }
  /**
   * Applies the operator's answer under the task lock (the same one retry/cancel and the
   * worker use), so two answers at once (web and Telegram) never act twice.
   */
  async answerDecision(
    tenantId: string,
    decisionId: string,
    answer: DecisionAnswer,
    via: 'web' | 'telegram' | 'api',
  ): Promise<Decision> {
    const found = await this.db.getRepository(Decision).findOneBy({ id: decisionId, tenantId });
    if (!found) throw new JobRejected('not_found', 'Unknown decision');
    return this.db.transaction(async (em) => {
      const [{ locked }] = await em.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [found.taskId],
      );
      if (!locked) throw new JobRejected('conflict', 'The task is running right now; try later');
      const decision = await em.findOneByOrFail(Decision, { id: decisionId });
      if (decision.status !== 'open')
        throw new JobRejected('conflict', 'Decision already answered');
      const task = await em.findOneByOrFail(Task, { id: decision.taskId });
      const entity = decision.revisionId ? Revision : Task;
      const job = decision.revisionId
        ? await em.findOneByOrFail(Revision, { id: decision.revisionId })
        : task;
      // The answer itself is the clarification: prompts rebuild them from answered decisions.
      let stored: Record<string, unknown>;
      if (decision.type === 'question') {
        const questions = decision.questions ?? [];
        const answers = 'answers' in answer ? answer.answers.map((a) => a.trim()) : [];
        if (answers.length !== questions.length || answers.some((a) => !a))
          throw new JobRejected('invalid', 'Answer every question');
        if (job.status !== 'WAITING')
          throw new JobRejected('conflict', `The job is not waiting (status: ${job.status})`);
        // A method's gate or stop resumes where it waited (its commits are already there).
        await this.requeue(em, job, entity, task.id, !!job.result?.method || !!job.result?.promote);
        stored = { answers: answers.map((a) => a.slice(0, 4000)) };
      } else {
        if (!('action' in answer))
          throw new JobRejected('invalid', 'Choose retry, retry with instructions or cancel');
        if (job.status !== 'FAILED')
          throw new JobRejected('conflict', `The job is not failed (status: ${job.status})`);
        if (answer.action === 'cancel') {
          assertTransition(job.status, 'CANCELLED');
          job.status = 'CANCELLED';
          job.error = 'Cancelled by the operator';
          await em.save(entity as EntityTarget<Task | Revision>, job);
          stored = { action: 'cancel' };
        } else if (answer.action === 'retry_with_instructions') {
          const instructions = answer.instructions.trim().slice(0, 4000);
          if (!instructions) throw new JobRejected('invalid', 'Write the instructions');
          await this.requeue(em, job, entity, task.id);
          stored = { action: answer.action, instructions };
        } else {
          // A method resumes where it stopped (its commits and the gate's words are kept): the
          // usual cause is outside (VPN, quota). With instructions it starts over, above.
          await this.requeue(
            em,
            job,
            entity,
            task.id,
            !!job.result?.method || !!job.result?.promote,
          );
          stored = { action: answer.action };
        }
      }
      Object.assign(decision, {
        status: 'answered',
        answer: stored,
        answeredVia: via,
        answeredAt: new Date(),
      });
      return em.save(Decision, decision);
    });
  }
  /**
   * Advances a sub-task delivery: queues the first step without a revision, provided every
   * earlier step succeeded. A failed step stops the chain until it is retried; idempotent.
   */
  async nextStep(task: Task): Promise<StepProgress> {
    const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
    const steps = issue.meta?.steps ?? [];
    if (steps.length < 2) return steps.length ? { state: 'complete', steps } : { state: 'none' };
    for (const [index, step] of steps.entries()) {
      if (index === 0) continue; // delivered by the task itself
      const existing = await this.db
        .getRepository(Revision)
        .findOneBy({ taskId: task.id, externalId: `jira-subtask:${step.externalId}` });
      if (existing?.status === 'SUCCESS') continue;
      if (existing) return { state: 'waiting' };
      await this.requestRevision(
        task.tenantId,
        { taskId: task.id },
        {
          id: step.revisionId,
          instructions: step.body,
          origin: 'jira-subtask',
          externalId: `jira-subtask:${step.externalId}`,
          externalKey: step.key,
          title: step.title,
          attachments: step.attachments,
        },
      );
      return { state: 'queued', step, index };
    }
    return { state: 'complete', steps };
  }
  /**
   * branch-per-subtask: after a sub-task's PR is open, queues the next sub-task as its own task,
   * branching from the previous sub-task (it usually needs its migration or backend) with its
   * PR into the story branch. Idempotent (accept dedupes by sub-task).
   */
  async nextStackedStep(
    task: Task,
  ): Promise<
    | { state: 'none' }
    | { state: 'queued'; task: Task; step: StepPlan }
    | { state: 'complete'; story: StoryPlan }
  > {
    const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
    const story = issue.meta?.story;
    if (!story) return { state: 'none' };
    const index = issue.meta?.stepIndex ?? 0;
    const next = story.steps[index + 1];
    if (!next) return { state: 'complete', story };
    const project = await this.db.getRepository(Project).findOneByOrFail({ id: issue.projectId });
    const queued = await this.accept(task.tenantId, {
      source: issue.source,
      externalId: next.externalId,
      key: next.key,
      title: next.title,
      body: next.body,
      url: issue.url.replace(/[^/]+$/, next.key),
      project: project.key,
      attachments: next.attachments,
      delivery: {
        baseRef: task.branch,
        prTarget: story.branch,
        story,
        stepIndex: index + 1,
      },
    });
    return { state: 'queued', task: queued, step: next };
  }
  /** Finds the tenant's task behind a pull request of one of its repositories. */
  private async taskByPullRequest(tenantId: string, repository: string, prNumber: number) {
    for (const pr of await this.db.getRepository(PullRequest).findBy({ number: prNumber })) {
      const task = await this.db.getRepository(Task).findOneBy({ id: pr.taskId, tenantId });
      if (!task) continue;
      const issue = await this.db.getRepository(Issue).findOneBy({ id: task.issueId });
      if (issue?.repository.toLowerCase() === repository.toLowerCase()) return task;
    }
    return null;
  }
  async requestRevision(
    tenantId: string,
    target: RevisionTarget,
    request: RevisionRequest,
  ): Promise<Revision> {
    const found =
      'taskId' in target
        ? await this.db.getRepository(Task).findOneBy({ id: target.taskId, tenantId })
        : await this.taskByPullRequest(tenantId, target.repository, target.prNumber);
    if (!found) throw new RevisionRejected('not_found', 'No AI task for this target');
    return this.db.transaction(async (em) => {
      // Serializes numbering and duplicate triggers for the same task.
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`revision:${found.id}`]);
      const task = await em.findOneByOrFail(Task, { id: found.id });
      if (request.externalId) {
        const existing = await em.findOneBy(Revision, {
          taskId: task.id,
          externalId: request.externalId,
        });
        if (existing) return existing;
      }
      // A rehearsal has no pull request: its adjustments land in the same workspace folder.
      const rehearsal = task.result?.rehearsal as { discarded?: boolean } | undefined;
      if (rehearsal?.discarded)
        throw new RevisionRejected('not_ready', 'Ensaio descartado: crie uma nova tarefa');
      if (
        task.status !== 'SUCCESS' ||
        (!rehearsal && !(await em.existsBy(PullRequest, { taskId: task.id })))
      )
        throw new RevisionRejected('not_ready', 'The task has no pull request yet');
      const all = await em.findBy(Revision, { taskId: task.id });
      if (
        COUNTED(request.origin) &&
        all.filter((r) => COUNTED(r.origin)).length >= config().MAX_REVISIONS
      )
        throw new RevisionRejected(
          'limit',
          `Revision limit reached (${config().MAX_REVISIONS}); open a new task`,
        );
      const revision = await em.save(Revision, {
        id: request.id ?? randomUUID(),
        taskId: task.id,
        number: all.length + 1,
        instructions: request.instructions,
        origin: request.origin,
        externalKey: request.externalKey ?? null,
        title: request.title ?? null,
        requestedBy: request.requestedBy ?? null,
        externalId: request.externalId ?? null,
        attachments: request.attachments?.length ? request.attachments : null,
        status: 'PENDING',
        stage: 'QUEUED',
        attempts: 0,
      });
      await em.save(Outbox, { taskId: task.id, revisionId: revision.id });
      return revision;
    });
  }
}
