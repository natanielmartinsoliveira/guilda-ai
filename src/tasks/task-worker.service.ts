import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityTarget, IsNull, LessThan } from 'typeorm';
import { Channel, ConsumeMessage } from 'amqplib';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { attachmentsDir, revisionFolder } from '../attachments/attachments';
import { AgentInput, ATTACHMENTS_MOUNT } from '../agents/agent.types';
import { config, TaskError, log, redact } from '../config';
import {
  Task,
  Issue,
  Project,
  PullRequest,
  Outbox,
  AgentRun,
  Revision,
  StepPlan,
  StoryPlan,
  Decision,
  Clarification,
} from '../database/entities';
import {
  clarificationsFrom,
  clarificationsText,
  failureReason,
  MAX_QUESTIONS,
  NeedsInput,
  parseQuestions,
} from './decisions';
import {
  AgentRouter,
  CapacityError,
  roleTargets,
  RouterInput,
} from '../agents/agent-router.service';
import { AiRole } from '../tenants/tenants';
import { resolveHarness } from '../agents/harness';
import { DockerRunnerService } from '../agents/docker-runner.service';
import { auditable, ProcessRunnerService } from '../agents/process-runner.service';
import { TaskWorkspaces } from '../workspaces/task-workspaces.service';
import { TaskWorkspace } from '../workspaces/task-workspace';
import { CoderWorkspace } from '../workspaces/coder-workspace';
import {
  commentText,
  EVIDENCE_DIR,
  evidencePrompt,
  evidenceQuestion,
  readManifest,
} from '../evidence/evidence';
import { evidenceDir, kitDir } from '../evidence/evidence-store';
import { renderPrompt } from '../prompts/prompt-files';
import { language, t } from '../i18n';
import { loadMethod } from '../methods/method';
import { routeFromAnswer, routeQuestion } from '../methods/route-choice';
import { formatsFor } from '../formats/formats';
import { MethodRunner, porcelainPaths, readOutcome } from '../methods/runner';
import type { DecisionQuestion } from '../database/entities';
import { SandboxService } from '../agents/sandbox.service';
import { GitRemote, GitService } from '../git/git.service';
import { MessagingService } from '../messaging/messaging.service';
import { TenantRegistry, ProjectContext } from '../tenants/tenant-registry.service';
import { SourceEvent, SourceReporter } from '../sources/source-reporter.service';
import { assertTransition } from './status';
import { backOnly, frontSection } from './front-split';
import { DesignResult, DesignService } from '../design/design.service';
import { OrchestratorService } from './orchestrator.service';
import { notifyDecision, notifyPr, notifyRehearsal } from '../telegram/notify';
import { telegramEnabled } from '../telegram/enabled';
import { ChecksResult, ChecksService, checksSummary } from '../checks/checks.service';
import {
  parsePrSections,
  prTitle,
  parseReview,
  parseTag,
  renderPrTemplate,
  reviewSummary,
  Review,
  ReviewOutcome,
  withProjectRules,
} from './pr-description';
const messageSchema = z
  .object({
    taskId: z.uuid(),
    issueId: z.uuid(),
    type: z.enum(['CODE', 'REVISE']),
    // Informational: the provider actually used is chosen per run by the credential fallback.
    provider: z.enum(['codex', 'claude', 'openrouter', 'gemini']).nullish(),
    revisionId: z.uuid().nullish(),
  })
  .refine((m) => (m.type === 'REVISE') === !!m.revisionId);
/** One commit per sub-task, named after its card so the tracker links it. */
const stepCommit = (key: string, title: string) => `feat(ai): ${key} ${title}`.slice(0, 200);
/** Tasks and revisions share status, attempts, stage and result semantics. */
type Job = Task | Revision;
type JobEntity = typeof Task | typeof Revision;
interface JobRun {
  kind: 'task' | 'revision';
  entity: JobEntity;
  job: Job;
  tenantId: string;
  outbox: { taskId: string; revisionId?: string };
  execute(): Promise<void>;
  /** Feedback after the delivery is settled; must never throw. */
  succeeded(): Promise<void>;
  failed(error: string): Promise<void>;
}
interface WorkContext {
  tenant: ProjectContext['tenant'];
  /** Project configuration (tenants.yaml). */
  cfg: ProjectContext['project'];
  host: ProjectContext['host'];
  issue: Issue;
  /** Project row (database). */
  project: Project;
  remote: GitRemote;
  /** Where the task's working copy lives (this machine or the company's Coder workspace). */
  ws: TaskWorkspace;
}
interface ChangeSpec {
  task: Task;
  job: Job;
  entity: JobEntity;
  ctx: WorkContext;
  /** Leaves the workspace on the branch base and records job.result.baseSha on first run. */
  prepareBase(): Promise<void>;
  prompt(): Promise<{ prompt: string; attachments?: AgentInput['attachments'] }>;
  commitMessage: string;
  /** Card text to plan before coding (cards without sub-tasks), when a planner is set. */
  planFor?: string;
  /** The card's Front-end part, done after the rest by the frontend role, in its own commit. */
  front?: FrontPhase;
  /** Runs once the change is committed, before push or the end of a rehearsal. */
  afterCommit?(): Promise<void>;
}
interface FrontPhase {
  /** Where the design comes from; may stop for the operator (before any AI is spent). */
  design(clarifications: Clarification[]): Promise<DesignResult>;
  prompt(
    design: DesignResult,
  ): Promise<{ prompt: string; attachments?: AgentInput['attachments'] }>;
  backCommitMessage: string;
  commitMessage: string;
}
const NO_CHANGES = (error: unknown) =>
  error instanceof TaskError && error.message.startsWith('NO_CHANGES');
@Injectable()
export class TaskWorkerService implements OnModuleInit {
  constructor(
    private readonly db: DataSource,
    private readonly messaging: MessagingService,
    private readonly router: AgentRouter,
    private readonly sandbox: SandboxService,
    private readonly git: GitService,
    private readonly tenants: TenantRegistry,
    private readonly reporter: SourceReporter,
    private readonly containers: DockerRunnerService,
    private readonly orchestrator: OrchestratorService,
    private readonly checks: ChecksService,
    private readonly design: DesignService = new DesignService(),
    // Shared with GitService in the worker module: the task's workspace binding.
    private readonly workspaces: TaskWorkspaces = new TaskWorkspaces(new ProcessRunnerService(db)),
  ) {}
  onModuleInit() {
    this.messaging.consume((m, c) => this.handle(m, c));
  }
  async handle(message: ConsumeMessage, channel: Channel) {
    let body: z.infer<typeof messageSchema>;
    try {
      body = messageSchema.parse(JSON.parse(message.content.toString()));
    } catch {
      channel.nack(message, false, false);
      return;
    }
    const lock = this.db.createQueryRunner();
    await lock.connect();
    try {
      // Session lock per task: the task and its revisions never run concurrently, and it is
      // released by PostgreSQL if the worker dies.
      await lock.query('SELECT pg_advisory_lock(hashtext($1))', [body.taskId]);
      const task = await this.db.getRepository(Task).findOneBy({ id: body.taskId });
      if (!task || task.issueId !== body.issueId) {
        channel.nack(message, false, false);
        return;
      }
      if (body.type === 'CODE') {
        if (task.type !== 'CODE') {
          channel.nack(message, false, false);
          return;
        }
        await this.runJob(
          {
            kind: 'task',
            entity: Task,
            job: task,
            tenantId: task.tenantId,
            outbox: { taskId: task.id },
            execute: () => this.execute(task),
            succeeded: () => this.taskDone(task),
            failed: (error) => this.taskFailed(task, error),
          },
          message,
          channel,
        );
        return;
      }
      const revision = await this.db
        .getRepository(Revision)
        .findOneBy({ id: body.revisionId!, taskId: task.id });
      if (!revision) {
        channel.nack(message, false, false);
        return;
      }
      await this.runJob(
        {
          kind: 'revision',
          entity: Revision,
          job: revision,
          tenantId: task.tenantId,
          outbox: { taskId: task.id, revisionId: revision.id },
          execute: () => this.revise(task, revision),
          succeeded: () => this.revisionDone(task, revision),
          failed: (error) => this.revisionFailed(task, revision, error),
        },
        message,
        channel,
      );
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [body.taskId]).catch(() => {});
      await lock.release();
    }
  }
  private async runJob(run: JobRun, message: ConsumeMessage, channel: Channel) {
    const { job, kind } = run;
    const entity = run.entity as EntityTarget<Job>;
    const repo = this.db.getRepository<Job>(entity);
    const ids = { taskId: run.outbox.taskId, revisionId: run.outbox.revisionId };
    if (job.status === 'SUCCESS') {
      channel.ack(message);
      return;
    }
    // WAITING: only the operator's answer queues the job again; a stale message is dropped.
    if (job.status === 'FAILED' || job.status === 'CANCELLED' || job.status === 'WAITING') {
      channel.nack(message, false, false);
      return;
    }
    if (job.attempts >= config().MAX_ATTEMPTS) {
      const error = 'Retry limit reached after interrupted attempt';
      await this.db.transaction(async (em) => {
        await em.update(entity, job.id, { status: 'FAILED', error });
        const decision = await em.save(Decision, this.failureDecision(run, error));
        await notifyDecision(em, decision.id);
      });
      channel.nack(message, false, false);
      return;
    }
    if (job.status === 'RUNNING') {
      // Previous worker died. Its session lock is gone; close incomplete audit records.
      await this.db.getRepository(AgentRun).update(
        { taskId: run.outbox.taskId, status: 'RUNNING' },
        {
          status: 'FAILED',
          stderr: 'Worker interrupted',
          exitCode: -1,
          finishedAt: new Date(),
        },
      );
    } else assertTransition(job.status, 'RUNNING');
    job.status = 'RUNNING';
    job.attempts++;
    job.error = null;
    await repo.save(job);
    log(`${kind}.started`, { ...ids, provider: job.provider, attempt: job.attempts });
    try {
      await run.execute();
      assertTransition(job.status, 'SUCCESS');
      job.status = 'SUCCESS';
      job.stage = job.result?.rehearsal ? 'REHEARSED' : 'DONE';
      await repo.save(job);
      log(`${kind}.success`, { ...ids, status: job.status });
      channel.ack(message);
      await run.succeeded();
    } catch (caught) {
      let error = caught;
      if (error instanceof NeedsInput) {
        // Copied out: TypeScript does not keep the narrowing of a `let` inside callbacks.
        const questions = error.questions;
        const asked = await this.db.getRepository(Decision).countBy({
          taskId: run.outbox.taskId,
          revisionId: run.outbox.revisionId ?? IsNull(),
          type: 'question',
        });
        if (error.unlimited || asked < MAX_QUESTIONS) {
          // The AI asked instead of guessing: wait for the operator, without spending an attempt.
          assertTransition(job.status, 'WAITING');
          job.status = 'WAITING';
          job.stage = 'WAITING_INPUT';
          job.attempts--;
          job.error = null;
          await this.db.transaction(async (em) => {
            await em.save(entity, job);
            const decision = await em.save(Decision, {
              tenantId: run.tenantId,
              taskId: run.outbox.taskId,
              revisionId: run.outbox.revisionId ?? null,
              type: 'question',
              status: 'open',
              // Questions come from an agent that read the workspace: never forward a secret.
              questions: questions.map((q) => ({
                text: redact(q.text),
                ...(q.options ? { options: q.options.map(redact) } : {}),
              })),
            });
            await notifyDecision(em, decision.id);
          });
          log(`${kind}.waiting_input`, { ...ids, questions: questions.length });
          channel.ack(message);
          return;
        }
        error = new TaskError(
          `Card ambíguo demais: ${MAX_QUESTIONS} rodadas de dúvidas e ainda há perguntas: ${questions
            .map((q) => q.text)
            .join(' | ')
            .slice(0, 1500)}`,
        );
      }
      job.error = redact(`${job.stage}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof CapacityError) {
        // Nothing is wrong with the job: wait for the first credential to recover.
        // The attempt is given back so waiting never exhausts MAX_ATTEMPTS.
        assertTransition(job.status, 'PENDING');
        job.status = 'PENDING';
        job.stage = 'WAITING_CAPACITY';
        job.attempts--;
        job.result = { ...job.result, agentAttempts: error.attempts };
        await this.db.transaction(async (em) => {
          await em.save(entity, job);
          await em.save(Outbox, { ...run.outbox, availableAt: error.until });
        });
        log(`${kind}.waiting_capacity`, { ...ids, until: error.until.toISOString() });
        channel.nack(message, false, false);
        return;
      }
      const retry =
        error instanceof TaskError && error.retryable && job.attempts < config().MAX_ATTEMPTS;
      assertTransition(job.status, retry ? 'PENDING' : 'FAILED');
      job.status = retry ? 'PENDING' : 'FAILED';
      await this.db.transaction(async (em) => {
        await em.save(entity, job);
        if (retry)
          await em.save(Outbox, {
            ...run.outbox,
            availableAt: new Date(Date.now() + config().RETRY_DELAY_MS * job.attempts),
          });
        else {
          const decision = await em.save(Decision, this.failureDecision(run, job.error!));
          await notifyDecision(em, decision.id);
        }
      });
      log(`${kind}.failed`, { ...ids, status: job.status, error: job.error, retry });
      // Failed delivery retained in DLQ; a retry has its own durable outbox record.
      channel.nack(message, false, false);
      if (job.status === 'FAILED') await run.failed(job.error);
    }
  }
  /** A final failure becomes the operator's decision: retry, retry with instructions, cancel. */
  private failureDecision(run: JobRun, error: string): Partial<Decision> {
    return {
      tenantId: run.tenantId,
      taskId: run.outbox.taskId,
      revisionId: run.outbox.revisionId ?? null,
      type: 'failure',
      status: 'open',
      reason: failureReason(error),
      details: error.slice(-4000),
    };
  }
  /**
   * Tracker feedback happens after the delivery is settled and can never change its outcome.
   * `key` targets another card of the same source (a sub-task); default: the task's card.
   */
  private async report(task: Task, event: SourceEvent, key?: string) {
    try {
      const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
      await this.reporter.report(
        this.tenants.tenant(task.tenantId),
        { source: issue.source, externalKey: key ?? issue.externalKey },
        event,
      );
    } catch (error) {
      log('source.report_failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async taskDone(task: Task) {
    // Rehearsal: nothing was published, so no PR notice; the card only shows the delivery done.
    if (task.result?.rehearsal) {
      await this.report(task, { type: 'built' });
      return this.announceRehearsal(task, task.result.rehearsal);
    }
    const prUrl = String(task.result?.prUrl);
    const issue = await this.db.getRepository(Issue).findOneBy({ id: task.issueId });
    // Best effort, like tracker feedback: a failed warning never changes the delivery.
    if (telegramEnabled())
      await this.db
        .transaction((em) =>
          notifyPr(em, {
            tenantId: task.tenantId,
            taskId: task.id,
            card: issue?.externalKey ?? '',
            title: issue?.title ?? '',
            prUrl,
          }),
        )
        .catch((error: unknown) =>
          log('telegram.enqueue_failed', {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    if (issue?.meta?.story) {
      await this.report(task, { type: 'pr', prUrl });
      // A sub-task started on its own: the rest of the story is not this delivery's.
      if (issue.meta.single) return;
      return this.advanceStory(task, issue.meta.story);
    }
    const steps = issue?.meta?.steps ?? [];
    if (!steps.length) return this.report(task, { type: 'pr', prUrl });
    await this.report(
      task,
      { type: 'step-done', prUrl, commit: String(task.result?.commitSha) },
      steps[0].key,
    );
    if (steps.length > 1)
      await this.report(task, { type: 'pr-opened', prUrl, remaining: steps.length - 1 });
    await this.advance(task, prUrl);
  }
  /** Telegram: the rehearsal is ready to be checked in the workspace. Best effort. */
  private async announceRehearsal(task: Task, rehearsal: unknown, revision?: number) {
    if (!telegramEnabled()) return;
    const r = rehearsal as { workspace: string; branch: string; commitSha: string };
    const issue = await this.db.getRepository(Issue).findOneBy({ id: task.issueId });
    await this.db
      .transaction((em) =>
        notifyRehearsal(em, {
          tenantName: this.tenants.tenant(task.tenantId).name,
          card: issue?.externalKey ?? '',
          title: issue?.title ?? '',
          workspace: r.workspace,
          branch: r.branch,
          commitSha: r.commitSha,
          revision,
          evidence: (task.result?.evidence as { shots?: unknown[] } | undefined)?.shots?.length,
        }),
      )
      .catch((error: unknown) =>
        log('telegram.enqueue_failed', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  /** Queues the next sub-task step, or closes the delivery when every step is in. */
  private async advance(task: Task, prUrl: string) {
    try {
      const progress = await this.orchestrator.nextStep(task);
      if (progress.state === 'queued')
        await this.report(task, { type: 'step-started' }, progress.step.key);
      if (progress.state === 'complete') await this.report(task, { type: 'completed', prUrl });
    } catch (error) {
      log('task.advance_failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async taskFailed(task: Task, error: string) {
    await this.report(task, { type: 'failed', error });
    // A stacked chain stops here until this sub-task is retried; the story card says why.
    const issue = await this.db.getRepository(Issue).findOneBy({ id: task.issueId });
    const story = issue?.meta?.story;
    if (story)
      await this.report(
        task,
        { type: 'failed', error: `${issue.externalKey}: ${error}` },
        story.key,
      );
  }
  /** Stacked sub-tasks: the next one starts from this branch; the story card follows along. */
  private async advanceStory(task: Task, story: StoryPlan) {
    try {
      const progress = await this.orchestrator.nextStackedStep(task);
      if (progress.state === 'queued')
        await this.report(task, { type: 'step-started' }, progress.step.key);
      if (progress.state === 'complete')
        await this.report(task, { type: 'story-done', branch: story.branch }, story.key);
    } catch (error) {
      log('task.advance_failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.report(
        task,
        {
          type: 'failed',
          error: `não foi possível iniciar a próxima sub-tarefa: ${error instanceof Error ? error.message : String(error)}`,
        },
        story.key,
      );
    }
  }
  private async revisionDone(task: Task, revision: Revision) {
    // Rehearsal: nothing published, nobody to tell but the operator.
    if (revision.result?.rehearsal)
      return this.announceRehearsal(task, revision.result.rehearsal, revision.number);
    await this.commentRevision(task, revision);
    const prUrl = String(revision.result?.prUrl);
    const commit = String(revision.result?.commitSha);
    if (revision.origin !== 'jira-subtask')
      return this.report(task, { type: 'revised', prUrl, commit });
    await this.report(
      task,
      { type: 'step-done', prUrl, commit },
      revision.externalKey ?? undefined,
    );
    await this.advance(task, prUrl);
  }
  private async revisionFailed(task: Task, revision: Revision, error: string) {
    await this.commentRevision(task, revision);
    // The chain stops here until this step is retried; both cards say why.
    if (revision.origin === 'jira-subtask' && revision.externalKey)
      await this.report(task, { type: 'failed', error }, revision.externalKey);
    await this.report(task, {
      type: 'failed',
      error: revision.externalKey ? `${revision.externalKey}: ${error}` : error,
    });
  }
  private async stage(job: Job, entity: JobEntity, stage: string) {
    job.stage = stage;
    await this.db.getRepository<Job>(entity as EntityTarget<Job>).save(job);
    log('job.stage', { id: job.id, provider: job.provider, status: job.status, stage });
  }
  private async context(task: Task): Promise<WorkContext> {
    const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
    const project = await this.db.getRepository(Project).findOneByOrFail({ id: issue.projectId });
    if (project.tenantId !== task.tenantId || issue.tenantId !== task.tenantId)
      throw new TaskError('Task, issue and project belong to different tenants');
    // Provider policy (ai.providers) is enforced per credential by the AgentRouter.
    const { tenant, project: cfg, host } = this.tenants.project(task.tenantId, project.key);
    const ssh = host.gitSshCommand?.();
    const remote = {
      url: host.cloneUrl(cfg.repository),
      authHeader: host.gitAuthHeader(),
      ...(ssh ? { sshCommand: ssh } : {}),
    };
    // Before any git work: the git service runs every command in this workspace.
    const ws = this.workspaces.bind(task, cfg.workspace);
    return { tenant, cfg, host, issue, project, remote, ws };
  }
  /** Issue attachments plus, for a revision, its own files (in a subfolder of the same mount). */
  private attachments(task: Task, issue: Issue, revision?: Revision) {
    const files = [
      ...(issue.attachments ?? []),
      ...(revision?.attachments ?? []).map((a) => ({
        ...a,
        name: `${revisionFolder(revision!.id)}/${a.name}`,
      })),
    ];
    if (!files.length) return undefined;
    const dir = attachmentsDir(task.tenantId, issue.source, issue.externalId);
    if (!existsSync(dir))
      throw new TaskError(`Attachments missing on disk: ${files.map((f) => f.name).join(', ')}`);
    return { dir, files };
  }
  /** A prompt of the project, its company pack or the core (the first that has it). */
  private render(ctx: WorkContext, template: string, values: Record<string, string>) {
    return renderPrompt(template, values, ctx.tenant.packDir, ctx.cfg.id);
  }
  /** mount: where the agent sees them (the sandbox mount, or the task folder in a workspace). */
  private listAttachments(attachments?: AgentInput['attachments'], mount = ATTACHMENTS_MOUNT) {
    return attachments
      ? attachments.files
          .map((f) => `- ${mount}/${f.name} (${f.contentType}, ${f.size} bytes)`)
          .join('\n')
      : 'Nenhum.';
  }
  /**
   * Project commands (prepare, test): in the project's container when it declares a docker
   * runner (services reachable through its network), otherwise in the bubblewrap sandbox,
   * where tests get no network.
   */
  private command(
    task: Task,
    ctx: WorkContext,
    argv: string[],
    agent: 'dependencies' | 'tester',
    network: boolean,
  ) {
    // In the company's workspace: its own tools and services (docker) run the tests.
    if (ctx.ws.kind === 'coder')
      return ctx.ws.run(argv, { taskId: task.id, agent, timeoutMs: config().TEST_TIMEOUT_MS });
    const opts = {
      cwd: task.workspace,
      taskId: task.id,
      tenantId: task.tenantId,
      agent,
      timeoutMs: config().TEST_TIMEOUT_MS,
    };
    return ctx.cfg.runner
      ? this.containers.run(ctx.cfg.runner, argv, opts)
      : this.sandbox.run(argv[0], argv.slice(1), opts, network);
  }
  /**
   * Agent → diff → tests → review → commit → push, resumable after a crash at any step.
   * Shared by the first implementation and by revisions; only the base and prompt differ.
   * With a front part: design, back (coder, own commit), front (frontend role), then the rest.
   */
  private async applyChange(spec: ChangeSpec) {
    const { task, job, entity, ctx } = spec;
    const state = (job.result ??= {});
    const front = spec.front;
    if (!state.commitSha) {
      await this.stage(job, entity, 'WORKSPACE');
      await spec.prepareBase();
      const head = await this.git.git(task, ['rev-parse', 'HEAD']);
      // A crash between the back commit and its checkpoint: the commit itself says what it is.
      if (
        front &&
        state.backSha === undefined &&
        head !== state.baseSha &&
        (await this.git.git(task, ['log', '-1', '--format=%s'])) === front.backCommitMessage
      )
        state.backSha = head;
      // Nothing done yet. With a front part, a recorded back (even an empty one) is not redone.
      const fresh = head === state.baseSha && state.backSha === undefined;
      // Resumed after the back commit: only the front is left.
      const frontLeft = !!front && (fresh || head === state.backSha);
      // Set when an agent works in this run; used to hand failing tests back to it.
      let agentInput: RouterInput | undefined;
      if (fresh && ctx.cfg.prepare.length) {
        await this.stage(job, entity, 'DEPENDENCIES');
        const r = await this.command(task, ctx, ctx.cfg.prepare, 'dependencies', true);
        if (!r.success) throw new TaskError(`Dependency preparation failed: ${r.stderr}`);
      }
      // Everything the operator settled for this task applies to every prompt from now on.
      const settled = clarificationsFrom(
        await this.db.getRepository(Decision).findBy({ taskId: task.id, status: 'answered' }),
      );
      const notes = clarificationsText(settled);
      // The design comes first: when it is missing, the job stops before any AI is spent.
      let design: DesignResult | undefined;
      if (frontLeft) {
        await this.stage(job, entity, 'DESIGN');
        design = await front.design(settled);
      }
      if (fresh) {
        agentInput = await this.implement(spec, 'coder', await spec.prompt(), notes, !!front);
        if (front) {
          await this.testAndFix(spec, agentInput);
          state.backSha = (await this.commitIfChanged(spec, front.backCommitMessage)) ?? head;
          // Checkpoint now: a crash before the front must not look like a finished job.
          await this.db.getRepository<Job>(entity as EntityTarget<Job>).save(job);
        }
      }
      if (frontLeft)
        agentInput = await this.implement(
          spec,
          'frontend',
          await front.prompt(design!),
          notes,
          // After a real back, a front with nothing to change (already done, or not needed) is fine.
          state.backSha !== state.baseSha,
        );
      await this.testAndFix(spec, agentInput);
      await this.checkAndFix(spec, agentInput);
      // A second model reviews the change before anyone else sees it; findings go back to the
      // agent a bounded number of times. Resumed commits were reviewed (or not) already.
      if (agentInput) await this.reviewLoop(spec, agentInput, front ? 'frontend' : 'coder');
      if (front && frontLeft) {
        const sha = await this.commitIfChanged(spec, front.commitMessage);
        if (!sha && state.backSha === state.baseSha)
          throw new TaskError('NO_CHANGES: agent produced no changes');
        // With a back commit in between, the PR and the reviewer report the whole change.
        state.changes = {
          ...((state.changes as object | undefined) ?? {}),
          files: await this.git.changedSince(task, String(state.baseSha)),
        };
        state.commitSha = sha ?? String(state.backSha);
      } else if (fresh) {
        // Revalidate after tests: tests can also change files.
        state.changes = await this.git.validateChanges(task);
        await this.stage(job, entity, 'COMMIT');
        state.commitSha = await this.commitWork(
          task,
          ctx,
          spec.commitMessage,
          (state.changes as { files: string[] }).files,
        );
      } else state.commitSha = head;
      await this.stage(job, entity, 'COMMITTED');
    }
    // After the commit and before anything leaves (test evidence of a free-surface edit).
    if (spec.afterCommit) await spec.afterCommit();
    // Rehearsal: nothing leaves the workspace.
    if (ctx.cfg.delivery === 'rehearsal') return;
    await this.stage(job, entity, 'PUSH');
    // Never forced: a revision whose branch moved meanwhile is rejected, not overwritten.
    await this.git.push(task, String(state.commitSha), ctx.remote);
  }
  /**
   * One agent run (coder or frontend) from its base: the plan (coder only) and the operator's
   * clarifications in the prompt; questions stop the job; the change is validated. Returns its
   * input, so failing tests and reviews go back to the same agent.
   */
  private async implement(
    spec: ChangeSpec,
    role: 'coder' | 'frontend',
    built: { prompt: string; attachments?: AgentInput['attachments'] },
    notes: string,
    allowEmpty: boolean,
  ): Promise<RouterInput> {
    const { task, job, entity, ctx } = spec;
    const state = job.result!;
    // Every agent run starts from its base commit: a previous run may have been cut off by a
    // crash, an exhausted credential or a wait for capacity, leaving partial edits.
    const base = String(role === 'frontend' ? (state.backSha ?? state.baseSha) : state.baseSha);
    const reset = () => this.git.resetTo(task, base);
    await reset();
    const common = {
      taskId: task.id,
      tenantId: task.tenantId,
      attachments: built.attachments,
      // Resolved per run: a `git pull` in the harness repository applies immediately.
      harness: ctx.tenant.harness ? await resolveHarness(ctx.tenant.harness) : undefined,
      workspace: task.workspace,
      ...(ctx.ws.kind === 'coder' ? { remote: ctx.ws as CoderWorkspace } : {}),
    };
    // Cards without sub-tasks get a plan first, when the tenant names a planner. Kept in the job
    // result, so a resumed run does not pay for it again.
    if (role === 'coder' && spec.planFor && state.plan === undefined) {
      state.plan = await this.plan(spec, common, `${spec.planFor}${notes}`);
      await this.stage(job, entity, 'PLANNED');
    }
    await this.stage(job, entity, role === 'coder' ? 'AGENT' : 'FRONTEND');
    // Project rules (e.g. translations) and, with a PR template, the request for its prose.
    const prompt = await withProjectRules(
      `${
        role === 'coder' && state.plan
          ? `${built.prompt}\n\nPlano do arquiteto (siga-o; ajuste só se o código mostrar que está errado):\n${String(state.plan)}`
          : built.prompt
      }${notes}`,
      ctx.cfg,
      ctx.tenant.packDir,
      formatsFor(ctx.tenant, ctx.cfg).pullRequest.sections,
    );
    const input: RouterInput = { ...common, prompt };
    const run = await this.router.run(ctx.tenant, role, input, reset);
    job.provider = run.credential.provider;
    // A rerun replaces its own earlier attempts; the coder keeps only the planner's.
    state.agentAttempts = [
      ...((state.agentAttempts as { role?: string }[] | undefined) ?? []).filter((a) =>
        role === 'coder' ? a.role === 'planner' : a.role !== 'frontend',
      ),
      ...run.attempts,
    ];
    const result = run.result;
    if (!result.success) throw new TaskError(`Agent failed: ${result.errorText ?? result.stderr}`);
    const questions = parseQuestions(result.message);
    if (questions.length) {
      // Nothing built on a guess survives: back to the base before waiting.
      await this.git.resetTo(task, String(state.baseSha));
      throw new NeedsInput(questions);
    }
    state.summary = auditable(result.stdout.slice(-12000));
    if (result.message) state.message = auditable(result.message.slice(-20000));
    await this.stage(job, entity, 'DIFF');
    try {
      state.changes = await this.git.validateChanges(task);
    } catch (error) {
      // A back with nothing to do (a screen-only card) goes straight to the front.
      if (!(allowEmpty && NO_CHANGES(error))) throw error;
    }
    return input;
  }
  /** Commits what is in the workspace; undefined when there is nothing to commit. */
  private async commitIfChanged(spec: ChangeSpec, message: string) {
    const { task, job, entity, ctx } = spec;
    try {
      job.result!.changes = await this.git.validateChanges(task);
    } catch (error) {
      if (NO_CHANGES(error)) return undefined;
      throw error;
    }
    await this.stage(job, entity, 'COMMIT');
    return this.commitWork(task, ctx, message, (job.result!.changes as { files: string[] }).files);
  }
  private record(job: Job, attempts: unknown[], provider?: Job['provider']) {
    const state = job.result!;
    state.agentAttempts = [...((state.agentAttempts as unknown[] | undefined) ?? []), ...attempts];
    if (provider) job.provider = provider;
  }
  /** Tests always run, including after a crash between commit and DB checkpoint. */
  private async testAndFix(spec: ChangeSpec, agentInput?: RouterInput) {
    const { task, job, entity, ctx } = spec;
    const state = job.result!;
    const test = ctx.cfg.test;
    const runTests = async () => {
      await this.stage(job, entity, 'TESTS');
      const before = await this.git.changedPaths(task);
      const r = await this.command(task, ctx, test, 'tester', false);
      // Tests may delete fixtures or write files: that is not part of the change.
      const reverted = await this.git.revertSideEffects(task, before);
      state.validation = {
        command: test,
        exitCode: r.exitCode,
        // From a company's workspace only a short tail is kept here.
        stdout: auditable(
          ctx.ws.kind === 'coder'
            ? r.stdout.trimEnd().split('\n').slice(-40).join('\n')
            : r.stdout.slice(-8000),
        ),
        ...(reverted.length ? { revertedSideEffects: reverted.slice(0, 50) } : {}),
      };
      return r;
    };
    let validation = await runTests();
    // Failing tests go back to the agent, a bounded number of times. Its edits are kept
    // (no reset): the fix builds on them.
    const maxFixes = config().TEST_FIX_ATTEMPTS;
    for (let fix = 1; !validation.success && agentInput && fix <= maxFixes; fix++) {
      await this.stage(job, entity, 'FIXING');
      const output = `${validation.stdout}\n${validation.stderr}`.slice(-12000);
      const fixInput: RouterInput = {
        ...agentInput,
        prompt: await this.render(ctx, 'fixer.md', {
          ATTEMPT: String(fix),
          MAX: String(maxFixes),
          COMMAND: test.join(' '),
          OUTPUT: redact(output),
          TASK_PROMPT: agentInput.prompt,
        }),
      };
      const run = await this.router.run(ctx.tenant, 'fixer', fixInput, async () => {});
      this.record(job, run.attempts, run.credential.provider);
      state.fixAttempts = Number(state.fixAttempts ?? 0) + 1;
      if (!run.result.success)
        throw new TaskError(
          `Agent failed while fixing tests: ${run.result.errorText ?? run.result.stderr}`,
        );
      // The fixer restates the PR block when it changes what was done.
      if (run.result.message?.includes('<pr>'))
        state.message = auditable(run.result.message.slice(-20000));
      state.changes = await this.git.validateChanges(task);
      validation = await runTests();
    }
    if (!validation.success) throw new TaskError(`Tests failed: ${validation.stderr}`);
  }
  /**
   * Local security checks on what the change introduced. New findings go back to the fixer
   * (same budget as failing tests), and the tests run again after each fix. A tool that cannot
   * run is reported in the PR but never blocks.
   */
  private async checkAndFix(spec: ChangeSpec, agentInput?: RouterInput) {
    const { task, job, entity, ctx } = spec;
    const cfg = ctx.cfg.checks;
    if (!cfg) return;
    const state = job.result!;
    const maxFixes = config().TEST_FIX_ATTEMPTS;
    for (let fix = 0; ; fix++) {
      await this.stage(job, entity, 'CHECKS');
      const result: ChecksResult = await this.checks.run(task, cfg, String(state.baseSha));
      state.checks = { ...result, blocking: cfg.blocking, reportOnly: cfg.reportOnly };
      const blocking = cfg.blocking
        ? result.findings.filter((f) => !cfg.reportOnly.includes(f.tool))
        : [];
      if (!blocking.length) return;
      const list = blocking
        .map(
          (f) => `- [${f.tool}] ${f.rule} em ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`,
        )
        .join('\n');
      if (!agentInput || fix >= maxFixes)
        throw new TaskError(`Security checks failed:\n${list.slice(0, 3000)}`);
      await this.stage(job, entity, 'FIXING_CHECKS');
      const run = await this.router.run(
        ctx.tenant,
        'fixer',
        {
          ...agentInput,
          prompt: await this.render(ctx, 'checks.md', {
            ATTEMPT: String(fix + 1),
            MAX: String(maxFixes),
            FINDINGS: redact(list),
            TASK_PROMPT: agentInput.prompt,
          }),
        },
        async () => {},
      );
      this.record(job, run.attempts, run.credential.provider);
      if (!run.result.success)
        throw new TaskError(
          `Agent failed while fixing security findings: ${run.result.errorText ?? run.result.stderr}`,
        );
      if (run.result.message?.includes('<pr>'))
        state.message = auditable(run.result.message.slice(-20000));
      state.changes = await this.git.validateChanges(task);
      await this.testAndFix(spec, agentInput);
    }
  }
  /**
   * Optional roles (planner, reviewer) are best effort: no capacity or a broken answer means
   * the delivery goes on without them, and the PR says so.
   */
  private async optionalRun(spec: ChangeSpec, role: AiRole, input: RouterInput) {
    try {
      const run = await this.router.run(spec.ctx.tenant, role, input, async () => {});
      this.record(spec.job, run.attempts);
      if (!run.result.success)
        return { skipped: redact(run.result.errorText ?? run.result.stderr).slice(-500) };
      return { message: run.result.message ?? '' };
    } catch (error) {
      if (error instanceof CapacityError) this.record(spec.job, error.attempts);
      return {
        skipped: redact(error instanceof Error ? error.message : String(error)).slice(-500),
      };
    }
  }
  /** Read-only planning of a card without sub-tasks; '' when there is no planner or no plan. */
  private async plan(spec: ChangeSpec, base: Omit<RouterInput, 'prompt'>, issue: string) {
    if (!roleTargets(spec.ctx.tenant, 'planner').length) return '';
    await this.stage(spec.job, spec.entity, 'PLANNING');
    const out = await this.optionalRun(spec, 'planner', {
      ...base,
      readOnly: true,
      prompt: await this.render(spec.ctx, 'planner.md', {
        ISSUE: issue,
        RULES: spec.ctx.cfg.instructions ?? 'Nenhuma.',
        ATTACHMENTS: this.listAttachments(base.attachments, spec.ctx.ws.attachmentsPath),
        REPOSITORY: spec.ctx.issue.repository,
      }),
    });
    const questions = parseQuestions(out.message);
    if (questions.length) throw new NeedsInput(questions);
    const plan = parseTag(out.message, 'plano');
    if (!plan)
      log('agent.plan_skipped', { id: spec.job.id, reason: out.skipped ?? 'no <plano> block' });
    return auditable((plan ?? '').slice(0, 20000));
  }
  private async reviewLoop(
    spec: ChangeSpec,
    coderInput: RouterInput,
    role: 'coder' | 'frontend' = 'coder',
  ) {
    const { task, job, entity, ctx } = spec;
    if (!roleTargets(ctx.tenant, 'reviewer').length) return;
    const state = job.result!;
    const rounds: Review[] = [];
    const save = (final: ReviewOutcome['final'], skipped?: string) => {
      state.review = { final, rounds, ...(skipped ? { skipped } : {}) } satisfies ReviewOutcome;
    };
    for (let round = 1; round <= ctx.tenant.ai.review.rounds; round++) {
      await this.stage(job, entity, 'REVIEW');
      // Since the job's base: a back commit made earlier in this job is part of the change.
      // In a company's workspace the diff stays there: the reviewer reads it itself.
      const remote = ctx.ws.kind === 'coder';
      const diff = remote
        ? { text: '', untracked: (await this.git.changedPaths(task)).untracked }
        : await this.git.diff(task, String(state.baseSha));
      const out = await this.optionalRun(spec, 'reviewer', {
        ...coderInput,
        readOnly: true,
        prompt: await this.render(ctx, 'code-review.md', {
          TASK_PROMPT: coderInput.prompt,
          DIFF: remote
            ? `(Leia a mudança na pasta da tarefa: \`git diff ${String(state.baseSha)}\` e \`git status\`.)`
            : diff.text.slice(0, 80000) || '(sem alterações em arquivos existentes)',
          NEW_FILES: diff.untracked.map((f) => `- ${f}`).join('\n') || 'Nenhum.',
          TRUNCATED:
            !remote && diff.text.length > 80000
              ? 'O diff acima foi truncado: leia os arquivos alterados.'
              : '',
        }),
      });
      const review = parseReview(out.message);
      if (!review) {
        const reason = out.skipped ?? 'resposta sem bloco <revisao>';
        log('agent.review_skipped', { id: job.id, reason });
        return save(rounds.length ? 'changes-addressed' : 'skipped', reason);
      }
      rounds.push(review);
      if (review.verdict === 'aprovado') return save('approved');
      // Findings go back to the agent that wrote last (same role and fallback).
      await this.stage(job, entity, 'REVIEW_FIX');
      const run = await this.router.run(
        ctx.tenant,
        role,
        {
          ...coderInput,
          prompt: await this.render(ctx, 'review-fix.md', {
            ISSUES: review.issues ?? review.summary ?? '',
            TASK_PROMPT: coderInput.prompt,
          }),
        },
        async () => {},
      );
      this.record(job, run.attempts, run.credential.provider);
      if (!run.result.success)
        throw new TaskError(
          `Agent failed while applying the review: ${run.result.errorText ?? run.result.stderr}`,
        );
      if (run.result.message?.includes('<pr>'))
        state.message = auditable(run.result.message.slice(-20000));
      state.changes = await this.git.validateChanges(task);
      await this.testAndFix(spec, coderInput);
      await this.checkAndFix(spec, coderInput);
    }
    save('changes-addressed');
  }
  /** Prompt for one step of a sub-task delivery, with the whole plan as context. */
  private stepPrompt(
    ctx: WorkContext,
    task: Task,
    issue: Issue,
    steps: Pick<StepPlan, 'key' | 'title' | 'body'>[],
    current: number,
    attachments: AgentInput['attachments'],
    story?: StoryPlan,
  ) {
    const step = steps[current];
    const base = String(task.result!.baseSha);
    return this.render(ctx, 'subtask.md', {
      DELIVERY: story
        ? 'uma branch e um PR por sub-tarefa, cada uma a partir da anterior'
        : 'um PR, um commit por sub-tarefa',
      PREVIOUS: story
        ? `veja com \`git log -n 20\`; a branch partiu de ${base}`
        : `veja com \`git log ${base}..HEAD\` e \`git diff ${base}..HEAD\``,
      ISSUE: story ? `${story.title}\n\n${story.body}` : task.instructions,
      PLAN: steps
        .map(
          (s, i) =>
            `${i + 1}. ${s.key} — ${s.title} (${i < current ? 'concluída' : i === current ? 'ATUAL' : 'próxima'})`,
        )
        .join('\n'),
      STEP_KEY: step.key,
      STEP_TITLE: step.title,
      STEP_BODY: step.body || '(sem descrição; use o título e a história)',
      ATTACHMENTS: this.listAttachments(attachments, this.workspaces.of(task).attachmentsPath),
      REPOSITORY: issue.repository,
      BRANCH: task.branch,
      TASK: task.id,
    });
  }
  async execute(task: Task) {
    const ctx = await this.context(task);
    const { issue, project, cfg } = ctx;
    const meta = issue.meta ?? {};
    const steps = meta.steps ?? [];
    const story = meta.story;
    // Stacked sub-tasks start from the previous one's branch and merge into the story branch.
    const base = meta.baseRef ?? project.defaultBranch;
    const target = meta.prTarget ?? project.defaultBranch;
    task.result ??= {};
    const stepBody = story
      ? (story.steps[meta.stepIndex ?? 0]?.body ?? task.instructions)
      : task.instructions;
    // Cards and story sub-tasks with a Front-end section, when the company has a front role.
    const frontPart =
      !steps.length && roleTargets(ctx.tenant, 'frontend').length
        ? frontSection(stepBody, formatsFor(ctx.tenant, ctx.cfg).card)
        : undefined;
    const commitMessage = story
      ? stepCommit(issue.externalKey, issue.title)
      : steps.length
        ? stepCommit(steps[0].key, steps[0].title)
        : `feat(ai): implement ${issue.externalKey}`;
    if (cfg.method && !meta.route) await this.chooseRoute(task, ctx);
    // A method route runs the method's phases; a standard-flow route of a method runs the core
    // flow with the method's hooks before it and its text after the prompt.
    const runner = cfg.method ? this.methodRunner(task, ctx) : undefined;
    const standardRoute = runner?.route.flow === 'standard' ? runner : undefined;
    if (runner && !standardRoute) await this.applyMethod(task, ctx, base);
    else
      await this.applyChange({
        task,
        job: task,
        entity: Task,
        ctx,
        prepareBase: async () => {
          // No recorded base: first run, or a retry that starts over from the current base tip.
          const first = !task.result!.baseSha;
          if (
            first &&
            meta.ensureBase &&
            base !== project.defaultBranch &&
            !(await this.git.remoteBranchExists(task, ctx.remote, base))
          ) {
            // The story branch is created from the default branch tip by its first sub-task.
            await this.git.prepare(task, project.defaultBranch, ctx.remote, {
              resetToBase: true,
              newBranch: true,
              hidden: cfg.hiddenFiles,
            });
            const tip = await this.git.git(task, ['rev-parse', 'HEAD']);
            await this.git.ensureRemoteBranch(task, ctx.remote, base, tip);
          }
          await this.git.prepare(task, base, ctx.remote, {
            resetToBase: first,
            newBranch: true,
            hidden: cfg.hiddenFiles,
          });
          if (standardRoute) await standardRoute.prepare(first);
          if (first) {
            task.result!.baseSha = await this.git.git(task, ['rev-parse', 'HEAD']);
            await this.stage(task, Task, 'PREPARED');
          }
        },
        prompt: async () => {
          const attachments = this.attachments(task, issue);
          // A sub-task delivery starts with its first step only.
          const prompt = story
            ? await this.stepPrompt(
                ctx,
                task,
                issue,
                story.steps,
                meta.stepIndex ?? 0,
                attachments,
                story,
              )
            : steps.length
              ? await this.stepPrompt(ctx, task, issue, steps, 0, attachments)
              : await this.render(ctx, 'coder.md', {
                  ISSUE: task.instructions,
                  ATTACHMENTS: this.listAttachments(
                    attachments,
                    this.workspaces.of(task).attachmentsPath,
                  ),
                  REPOSITORY: issue.repository,
                  BRANCH: task.branch,
                  TASK: task.id,
                });
          const extra = standardRoute?.append();
          const surface = extra ? `\n\n${extra}` : '';
          return {
            prompt: `${frontPart ? `${prompt}\n\n${await backOnly(ctx.tenant.packDir, ctx.cfg.id)}` : prompt}${surface}`,
            attachments,
          };
        },
        // Sub-tasks already are the plan; a card without them gets one from the planner.
        planFor: story || steps.length ? undefined : task.instructions,
        commitMessage,
        ...(standardRoute?.route.evidence
          ? { afterCommit: () => this.collectEvidence(task, ctx, standardRoute.routeId) }
          : {}),
        front: frontPart
          ? {
              backCommitMessage: `${commitMessage} (back-end)`,
              commitMessage: `${commitMessage} (front-end)`,
              design: (clarifications) =>
                this.design.prepare({
                  tenant: ctx.tenant,
                  texts: [stepBody, clarificationsText(clarifications), story?.body ?? ''],
                  about: `${issue.title}\n${frontPart}`,
                  clarifications,
                  images: (issue.attachments ?? []).filter((a) =>
                    a.contentType.startsWith('image/'),
                  ).length,
                  dir: attachmentsDir(task.tenantId, issue.source, issue.externalId),
                }),
              prompt: async (design) => {
                const own = this.attachments(task, issue);
                const attachments = design.files.length
                  ? {
                      dir: attachmentsDir(task.tenantId, issue.source, issue.externalId),
                      files: [...(own?.files ?? []), ...design.files],
                    }
                  : own;
                const prompt = await this.render(ctx, 'frontend.md', {
                  DESIGN: design.note,
                  BACK: String(task.result!.message ?? 'A fase de back não deixou resumo.'),
                  ISSUE: story ? `${story.title}\n\n${story.body}` : '',
                  STEP_KEY: issue.externalKey,
                  STEP_TITLE: issue.title,
                  STEP_BODY: stepBody,
                  FRONT: frontPart,
                  ATTACHMENTS: this.listAttachments(
                    attachments,
                    this.workspaces.of(task).attachmentsPath,
                  ),
                  REPOSITORY: issue.repository,
                  BRANCH: task.branch,
                  TASK: task.id,
                });
                return { prompt, attachments };
              },
            }
          : undefined,
      });
    if (cfg.delivery === 'rehearsal') {
      // Nothing published: where to look, for the operator to check by hand.
      task.result.rehearsal = {
        workspace: ctx.ws.label,
        branch: task.branch,
        commitSha: String(task.result.commitSha),
        files: (task.result.changes as { files?: string[] } | undefined)?.files ?? [],
        tests: String((task.result.validation as { stdout?: string } | undefined)?.stdout ?? ''),
      };
      return;
    }
    await this.stage(task, Task, 'PULL_REQUEST');
    const prSections = formatsFor(ctx.tenant, cfg).pullRequest.sections;
    const body = cfg.pullRequest.template
      ? await renderPrTemplate(
          cfg,
          config().TENANTS_FILE,
          {
            key: issue.externalKey,
            title: issue.title,
            url: issue.url,
            branch: task.branch,
            body: issue.body,
            changedFiles: (task.result.changes as { files?: string[] } | undefined)?.files ?? [],
            testsPassed:
              (task.result.validation as { exitCode?: number } | undefined)?.exitCode === 0,
            testCommand: cfg.test,
            sections: parsePrSections(task.result.message as string | undefined, prSections),
            review: task.result.review as ReviewOutcome | undefined,
            checks: task.result.checks as (ChecksResult & { blocking?: boolean }) | undefined,
          },
          prSections,
        )
      : this.defaultPrBody(task, issue, steps);
    const pr = await ctx.host.ensurePullRequest(ctx.cfg.repository, {
      branch: task.branch,
      base: target,
      title: (cfg.pullRequest.title
        ? prTitle(cfg.pullRequest.title, issue.externalKey, issue.title)
        : cfg.pullRequest.template
          ? `${issue.externalKey} ${issue.title}`
          : `AI: ${issue.externalKey} ${issue.title}`
      ).slice(0, 256),
      body: body.slice(0, 60000),
      draft: cfg.delivery === 'draft',
      reviewers: cfg.pullRequest.reviewers,
    });
    await this.db.getRepository(PullRequest).upsert(
      {
        taskId: task.id,
        host: ctx.host.id,
        externalId: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        branch: task.branch,
        baseBranch: target,
        state: pr.state,
      },
      ['taskId'],
    );
    task.result.prUrl = pr.url;
  }
  private defaultPrBody(task: Task, issue: Issue, steps: StepPlan[]) {
    // Without a tracker link (API/VS Code tasks), the request itself is the reviewer's context.
    const origin =
      issue.closingRef ??
      (issue.url ? `Source: ${issue.url}` : `### Request\n${issue.body.slice(0, 20000)}`);
    const plan = steps.length
      ? `\n\n### Sub-tasks (one commit each, in this order)\n${steps.map((s) => `- ${s.key} ${s.title}`).join('\n')}`
      : '';
    return `## AI Dev Team\n\n${origin}${plan}\n\n### Agent\n${task.provider}\n\n### Task\n${task.id}: ${issue.externalKey} ${issue.title}\n\n### Changes\n${JSON.stringify(task.result?.changes ?? {})}\n\n### Validation\n${JSON.stringify(task.result?.validation ?? {})}\n\n### Review\n${reviewSummary(task.result?.review as ReviewOutcome | undefined)}\n\n### Security checks\n${checksSummary(task.result?.checks as (ChecksResult & { blocking?: boolean }) | undefined)}\n\n### Automated\nThis PR was created by the AI Dev Team. Comment \`/ai <instructions>\` to request changes.`;
  }
  /** A new commit on the PR branch, on top of whatever is there now (human commits included). */
  /**
   * A project with a company method (methods/<name>/ of its pack): the method's phases do the
   * work, and the core prepares the workspace, turns every stop into a decision, runs the
   * project's tests and checks, and delivers.
   */
  private async applyMethod(task: Task, ctx: WorkContext, base: string) {
    const runner = this.methodRunner(task, ctx);
    await runner.run(base);
    if (ctx.cfg.delivery === 'rehearsal') {
      // The finished rehearsal may advance something the method keeps (e.g. a specification).
      await runner.finishRehearsal();
      return;
    }
    await this.stage(task, Task, 'PUSH');
    await this.git.push(task, String(task.result!.commitSha), ctx.remote);
  }
  /**
   * A task of a method that came without a route (a card with no route tag): the operator picks
   * one of the method's routes; an answer that names none is asked again.
   */
  private async chooseRoute(task: Task, ctx: WorkContext) {
    const method = loadMethod(ctx.tenant.packDir!, ctx.cfg.method!.name);
    const question = routeQuestion(method, language());
    const last = (
      await this.db
        .getRepository(Decision)
        .findBy({ taskId: task.id, type: 'question', status: 'answered' })
    )
      .filter((d) => d.questions?.[0]?.text === question.text && d.answeredAt)
      .sort((a, b) => b.answeredAt!.getTime() - a.answeredAt!.getTime())[0];
    const answer = (last?.answer as { answers?: string[] } | undefined)?.answers?.[0];
    const route = answer === undefined ? undefined : routeFromAnswer(method, language(), answer);
    if (!route) throw new NeedsInput([question], true);
    ctx.issue.meta = { ...(ctx.issue.meta ?? {}), route };
    await this.db.getRepository(Issue).save(ctx.issue);
  }
  /** The runner of the project's method for this task. */
  private methodRunner(task: Task, ctx: WorkContext) {
    const spec = { task, job: task, entity: Task, ctx } as unknown as ChangeSpec;
    return new MethodRunner(
      {
        db: this.db,
        git: this.git,
        router: this.router,
        stage: (t, stage) => this.stage(t, Task, stage),
        record: (t, attempts, provider) => this.record(t, attempts as never, provider as never),
        tests: async () => {
          await this.testAndFix(spec);
          await this.checkAndFix(spec);
        },
        evidence: (route) => this.collectEvidence(task, ctx, route),
        board: (step) => this.report(task, { type: 'phase', board: step }),
      },
      task,
      ctx,
      ctx.issue.meta?.route,
    );
  }
  /**
   * Test evidence for the company's audit: the agent starts the system in the workspace and
   * runs a Playwright script that prints only through our kit (frame with the real URL and the
   * capture time, credentials masked). Prints and trace come back here; nothing is committed and
   * the kit folder is removed. A run that does not reach the result asks the operator.
   */
  private async collectEvidence(task: Task, ctx: WorkContext, route: string) {
    const ev = ctx.cfg.evidence;
    if (!ev) return;
    if (ctx.ws.kind !== 'coder')
      throw new TaskError('Evidência de teste só roda em workspace do Coder', false);
    const state = task.result!;
    // Its own questions (a standard-flow route has no method questions): the answer is a note.
    const ask = async (question: DecisionQuestion): Promise<never> => {
      state.evidenceAsked = question.text;
      await this.db.getRepository(Task).save(task);
      throw new NeedsInput([question], true);
    };
    const asked = state.evidenceAsked as string | undefined;
    state.evidenceAsked = undefined;
    const reply = asked
      ? (
          (
            await this.db
              .getRepository(Decision)
              .findBy({ taskId: task.id, type: 'question', status: 'answered' })
          )
            .filter((d) => d.questions?.[0]?.text === asked && d.answeredAt)
            .sort((a, b) => b.answeredAt!.getTime() - a.answeredAt!.getTime())[0]?.answer as
            { answers?: string[] } | undefined
        )?.answers?.[0]
      : undefined;
    const notes = [
      ...((state.evidenceNotes as string[] | undefined) ?? []),
      ...(reply ? [reply] : []),
    ];
    state.evidenceNotes = notes;
    await this.stage(task, Task, 'EVIDENCE');
    await ctx.ws.remove(EVIDENCE_DIR);
    const formats = formatsFor(ctx.tenant, ctx.cfg);
    const kit = await kitDir(ev.playwright, formats.evidence.timezone);
    try {
      await ctx.ws.upload(kit, EVIDENCE_DIR);
    } finally {
      await rm(kit, { recursive: true, force: true });
    }
    const out = await this.router.run(
      ctx.tenant,
      'coder',
      {
        taskId: task.id,
        tenantId: task.tenantId,
        workspace: task.workspace,
        remote: ctx.ws as CoderWorkspace,
        timeoutMs: ev.timeoutMinutes * 60000,
        prompt: await evidencePrompt(
          {
            material: task.instructions,
            route,
            notes,
            version: ev.playwright,
          },
          ctx.tenant.packDir,
          ctx.cfg.id,
        ),
      },
      async () => {},
    );
    this.record(task, out.attempts, out.credential.provider);
    // The evidence touches nothing of the delivery: a commit or a stray file it left (compose
    // override, seed, .env) is undone, so neither is pushed nor blamed on the delivery later.
    const delivered = String(state.commitSha);
    const head = await this.git.git(task, ['rev-parse', 'HEAD']);
    const stray = porcelainPaths(
      await this.git.git(task, ['status', '--porcelain', '-z', '--untracked-files=all']),
    );
    if (head !== delivered || stray.length) {
      await this.git.git(task, ['reset', '--hard', delivered]);
      await this.git.git(task, ['clean', '-fd']);
      log('evidence.restored', { taskId: task.id, moved: head !== delivered, files: stray.length });
    }
    const outcome = out.result.success
      ? readOutcome(out.result.message)
      : { done: false as const, pending: out.result.errorText ?? out.result.stderr.slice(-2000) };
    if (!outcome.done) await ask(evidenceQuestion(outcome.pending));
    const manifest = readManifest(
      (await ctx.ws.readText(`${EVIDENCE_DIR}/out/manifest.json`, 200000)) ?? '',
    );
    if ('problem' in manifest)
      return ask(evidenceQuestion(t('evidence.invalid', { problem: manifest.problem })));
    const dir = evidenceDir(task.tenantId, task.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const shot of manifest.shots) {
      const png = await ctx.ws.readFile(`${EVIDENCE_DIR}/out/${shot.file}`, 15 * 1024 * 1024);
      if (!png?.length)
        return ask(evidenceQuestion(t('evidence.missingPrint', { file: shot.file })));
      await writeFile(join(dir, shot.file), png);
    }
    const trace = await ctx.ws.readFile(`${EVIDENCE_DIR}/out/trace.zip`, 50 * 1024 * 1024);
    if (trace?.length) await writeFile(join(dir, 'trace.zip'), trace);
    state.evidence = {
      shots: manifest.shots,
      comment: await commentText(manifest.shots, formats.evidence, ctx.tenant.packDir),
      ...(trace?.length ? { trace: 'trace.zip' } : {}),
    };
    await ctx.ws.remove(EVIDENCE_DIR);
    await this.db.getRepository(Task).save(task);
  }
  /** A method that commits its own work never gets `git add --all`: only the files of the change. */
  private commitWork(task: Task, ctx: WorkContext, message: string, files: string[]) {
    const author = { name: ctx.tenant.git.authorName, email: ctx.tenant.git.authorEmail };
    return ctx.cfg.method && this.methodRunner(task, ctx).method.commits === 'method'
      ? this.git.commitPaths(task, files, message, author)
      : this.git.commit(task, message, author);
  }
  async revise(task: Task, revision: Revision) {
    // A method may refuse adjustments (e.g. a change after delivery is a new task on its route).
    const rctx = await this.context(task);
    if (rctx.cfg.method) {
      const runner = this.methodRunner(task, rctx);
      if (runner.method.revisions === 'refuse')
        throw new TaskError(
          runner.message('revisionRefused', 'This method does not take adjustments'),
        );
    }
    // A rehearsal is adjusted in its own workspace folder: no PR, nothing fetched or pushed.
    const rehearsal = task.result?.rehearsal as Record<string, unknown> | undefined;
    if (rehearsal?.discarded) throw new TaskError('Ensaio descartado: crie uma nova tarefa');
    if (task.status !== 'SUCCESS' || !task.result?.baseSha)
      throw new TaskError('Task has no pull request to revise');
    const ctx = await this.context(task);
    const { issue, project } = ctx;
    const pr = rehearsal
      ? undefined
      : await this.db.getRepository(PullRequest).findOneBy({ taskId: task.id });
    if (!rehearsal && !pr) throw new TaskError('Task has no pull request to revise');
    const previous = await this.db.getRepository(Revision).find({
      where: { taskId: task.id, number: LessThan(revision.number) },
      order: { number: 'ASC' },
    });
    revision.result ??= {};
    // Sub-task steps use the delivery plan; other revisions are review feedback.
    const steps = issue.meta?.steps ?? [];
    const step =
      revision.origin === 'jira-subtask'
        ? steps.findIndex((s) => s.key === revision.externalKey)
        : -1;
    if (revision.origin === 'jira-subtask' && step < 0)
      throw new TaskError(`Sub-task ${revision.externalKey} is not in the delivery plan`);
    await this.applyChange({
      task,
      job: revision,
      entity: Revision,
      ctx,
      prepareBase: async () => {
        await this.git.prepare(task, project.defaultBranch, ctx.remote, {
          hidden: ctx.cfg.hiddenFiles,
        });
        if (!revision.result!.baseSha) {
          // Rehearsal: on top of the local commit; otherwise on top of the PR branch as it is.
          const head = rehearsal
            ? await this.git.git(task, ['rev-parse', 'HEAD'])
            : await this.git.fetchBranch(task, ctx.remote);
          await this.git.resetTo(task, head);
          revision.result!.baseSha = head;
          await this.stage(revision, Revision, 'PREPARED');
        }
      },
      prompt: async () => {
        const attachments = this.attachments(task, issue, revision);
        if (step >= 0)
          return {
            prompt: await this.stepPrompt(ctx, task, issue, steps, step, attachments),
            attachments,
          };
        const prompt = await this.render(ctx, 'reviser.md', {
          BASE: String(task.result!.baseSha),
          ISSUE: task.instructions,
          HISTORY:
            previous
              .map((r) => `- #${r.number} (${r.status}): ${r.instructions.slice(0, 2000)}`)
              .join('\n') || 'Nenhuma.',
          REQUEST: revision.instructions,
          ATTACHMENTS: this.listAttachments(attachments, this.workspaces.of(task).attachmentsPath),
          REPOSITORY: issue.repository,
          BRANCH: task.branch,
          TASK: task.id,
        });
        return { prompt, attachments };
      },
      commitMessage:
        step >= 0
          ? stepCommit(steps[step].key, steps[step].title)
          : `fix(ai): ${issue.externalKey} revision ${revision.number}`,
    });
    if (rehearsal) {
      // The rehearsal now points at the adjusted commit and the whole change since its base.
      const updated = {
        ...rehearsal,
        commitSha: String(revision.result.commitSha),
        files: await this.git.changedSince(task, String(task.result.baseSha)),
      };
      task.result = { ...task.result, rehearsal: updated };
      await this.db.getRepository(Task).save(task);
      revision.result.rehearsal = updated;
      return;
    }
    revision.result.prUrl = pr!.url;
  }
  /** The PR conversation is where a revision was asked for, so its outcome goes there. */
  private async commentRevision(task: Task, revision: Revision) {
    try {
      const ctx = await this.context(task);
      const pr = await this.db.getRepository(PullRequest).findOneBy({ taskId: task.id });
      if (!pr) return;
      const request = revision.instructions.slice(0, 300).replace(/\n/g, '\n> ');
      // The agent's answer to the reviewer: what it did for each point, what it did not and why.
      const answer = parseTag(revision.result?.message as string | undefined, 'resposta');
      const text =
        revision.status === 'SUCCESS'
          ? `AI Dev Team aplicou a revisão #${revision.number} (commit ${String(revision.result?.commitSha).slice(0, 7)}, ${revision.provider}), testes aprovados.${answer ? `\n\n${redact(answer).slice(0, 4000)}` : ''}\n\n> ${request}`
          : `AI Dev Team não conseguiu aplicar a revisão #${revision.number}: ${redact(revision.error ?? '').slice(0, 1500)}\n\n> ${request}`;
      await ctx.host.commentOnPullRequest(ctx.cfg.repository, pr.number, text);
    } catch (error) {
      log('revision.comment_failed', {
        revisionId: revision.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
