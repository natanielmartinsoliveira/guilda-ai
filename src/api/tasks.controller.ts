import { CardStarters, normalizeCardKey } from '../sources/card-starters';
import { loadMethod, methodRoutes } from '../methods/method';
import { language } from '../i18n';
import {
  Optional,
  Res,
  HttpException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { DataSource, In, MoreThan } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { config, redact, TaskError } from '../config';
import {
  attachmentsDir,
  IncomingFile,
  revisionFolder,
  saveAttachments,
} from '../attachments/attachments';
import {
  AgentRun,
  Decision,
  Issue,
  LessonSuggestion,
  Project,
  Revision,
  Task,
} from '../database/entities';
import { API_SOURCE, findTenant, ROLES, tenants, Tenant } from '../tenants/tenants';
import {
  DecisionAnswer,
  JobRejected,
  OrchestratorService,
  RevisionRejected,
} from '../tasks/orchestrator.service';
import { join, resolve } from 'node:path';
import { evidenceDir } from '../evidence/evidence-store';
import type { Shot } from '../evidence/evidence';
/** Prints and the trace of a task's test evidence, as the worker stores them. */
const EVIDENCE_FILE = /^(\d{2}-[a-z0-9-]+\.png|trace\.zip)$/;
function evidenceView(value: unknown) {
  const ev = value as { shots?: Shot[]; comment?: string; trace?: string } | undefined;
  if (!ev?.shots?.length) return undefined;
  return {
    shots: ev.shots.map((s) => ({ file: s.file, title: s.title, url: s.url, at: s.at })),
    comment: ev.comment ?? '',
    trace: !!ev.trace,
  };
}
import { OperatorGuard, OperatorRequest } from './api-token.guard';
import { credentialStatus, roleTargets } from '../agents/agent-router.service';
import { taskMetrics } from '../tasks/metrics';
import { addLesson, projectLessons } from '../prompts/lessons';
import { lessonText, visible } from '../prompts/lesson-capture';
import { restartRefusal } from '../tasks/orchestrator.service';
import { JiraPoller } from '../sources/jira/jira.poller';
import { ChangeFeed } from './change-feed';
const decisionAnswer = z.union([
  z.object({ answers: z.array(z.string().max(4000)).min(1).max(10) }),
  z.object({ action: z.enum(['retry', 'cancel']) }),
  z.object({
    action: z.literal('retry_with_instructions'),
    instructions: z.string().trim().min(1).max(4000),
  }),
]);
/** JobRejected → HTTP: unknown is 404, invalid input 400, wrong state 409. */
function httpError(error: JobRejected) {
  return error.reason === 'not_found'
    ? new NotFoundException(error.message)
    : error.reason === 'invalid'
      ? new BadRequestException(error.message)
      : new ConflictException(error.message);
}
const CARD_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const createTask = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().max(100000).default(''),
  project: z.string().optional(),
  /** Projects with a method: which of its routes the change takes, chosen by the operator. */
  route: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
});
@Controller('api')
@UseGuards(OperatorGuard)
export class TasksController {
  constructor(
    private readonly db: DataSource,
    private readonly orchestrator: OrchestratorService,
    private readonly poller: JiraPoller,
    // Optional so test modules that only exercise other routes need not provide it.
    @Optional() private readonly starters?: CardStarters,
  ) {}
  private tenant(id: string): Tenant {
    const tenant = findTenant(id);
    if (!tenant) throw new NotFoundException('Unknown tenant');
    return tenant;
  }
  @Get('tenants')
  listTenants() {
    // Configuration without secrets: enough for a client to pick tenant and project.
    return tenants().map((t) => ({
      id: t.id,
      name: t.name,
      concurrency: t.worker.concurrency,
      officeTheme: t.office.theme,
      providers: t.ai.providers,
      jira: t.sources.some((s) => s.type === 'jira'),
      // Sources that start a card the operator names by its key (Jira, Businessmap…).
      sources: this.starters?.list(t) ?? [],
      projects: t.projects.map((p) => ({
        id: p.id,
        repository: p.repository,
        method: p.method?.name,
        // The routes of the project's method, labelled in the instance language.
        ...(p.method && t.packDir
          ? { routes: methodRoutes(loadMethod(t.packDir, p.method.name), language()) }
          : {}),
      })),
    }));
  }
  @Get('tenants/:tenant/ai')
  async ai(@Param('tenant') tenantId: string) {
    const tenant = this.tenant(tenantId);
    // Order is the fallback order. Keys are never returned.
    return (await credentialStatus(this.db, tenant)).map((s) => ({
      id: s.credential.id,
      provider: s.credential.provider,
      model: s.credential.model,
      effort: s.credential.effort,
      // Roles this credential serves, with the model/effort each one uses.
      roles: ROLES.flatMap((role) =>
        roleTargets(tenant, role)
          .filter((t) => t.credential.id === s.credential.id)
          .map((t) => ({ role, model: t.model, effort: t.effort })),
      ),
      auth: s.credential.apiKey ? 'apiKey' : 'login',
      available: s.available,
      unavailableUntil: s.unavailableUntil,
      reason: s.reason,
      lastError: s.lastError,
    }));
  }
  @Post('tenants/:tenant/tasks')
  @HttpCode(202)
  @UseInterceptors(
    FilesInterceptor('files', config().ATTACHMENT_MAX_FILES, {
      limits: {
        fileSize: config().ATTACHMENT_MAX_BYTES,
        files: config().ATTACHMENT_MAX_FILES,
        fields: 10,
        fieldSize: 200000,
      },
    }),
  )
  async create(
    @Param('tenant') tenantId: string,
    @Body() body: unknown,
    @UploadedFiles() files: IncomingFile[] = [],
  ) {
    const tenant = this.tenant(tenantId);
    const parsed = createTask.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'title is required (max 256 chars); route is a route of the project method',
      );
    const { title, description } = parsed.data;
    const project =
      parsed.data.project ?? (tenant.projects.length === 1 ? tenant.projects[0].id : undefined);
    if (!project || !tenant.projects.some((p) => p.id === project))
      throw new BadRequestException(
        `project must be one of: ${tenant.projects.map((p) => p.id).join(', ')}`,
      );
    // A method's route is the operator's to state, never inferred.
    const cfg = tenant.projects.find((p) => p.id === project)!;
    const method =
      cfg.method && tenant.packDir ? loadMethod(tenant.packDir, cfg.method.name) : undefined;
    if (method && (!parsed.data.route || !Object.hasOwn(method.routes, parsed.data.route)))
      throw new BadRequestException(
        `${cfg.method!.name}: escolha a rota (${methodRoutes(method, language())
          .map((r) => `${r.id}: ${r.label}`)
          .join(', ')})`,
      );
    const externalId = randomUUID(),
      dir = attachmentsDir(tenant.id, API_SOURCE, externalId);
    try {
      // Files are durable before the task exists, so the worker never sees a partial set.
      const attachments = await saveAttachments(dir, files);
      const task = await this.orchestrator.accept(tenant.id, {
        source: API_SOURCE,
        externalId,
        key: `T-${externalId.slice(0, 8)}`,
        title,
        body: description,
        url: '',
        project,
        attachments,
        ...(method ? { delivery: { route: parsed.data.route } } : {}),
      });
      return {
        taskId: task.id,
        key: `T-${externalId.slice(0, 8)}`,
        status: task.status,
        attachments,
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  @Post('tenants/:tenant/tasks/:id/revisions')
  @HttpCode(202)
  @UseInterceptors(
    FilesInterceptor('files', config().ATTACHMENT_MAX_FILES, {
      limits: {
        fileSize: config().ATTACHMENT_MAX_BYTES,
        files: config().ATTACHMENT_MAX_FILES,
        fields: 5,
        fieldSize: 200000,
      },
    }),
  )
  async revise(
    @Param('tenant') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @UploadedFiles() files: IncomingFile[] = [],
  ) {
    const tenant = this.tenant(tenantId);
    const parsed = z.object({ instructions: z.string().trim().min(1).max(100000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('instructions is required');
    const task = await this.db.getRepository(Task).findOneBy({ id, tenantId: tenant.id });
    if (!task) throw new NotFoundException('Unknown task');
    const issue = await this.db.getRepository(Issue).findOneByOrFail({ id: task.issueId });
    const revisionId = randomUUID();
    const dir = resolve(
      attachmentsDir(tenant.id, issue.source, issue.externalId),
      revisionFolder(revisionId),
    );
    try {
      const attachments = await saveAttachments(dir, files);
      const revision = await this.orchestrator.requestRevision(
        tenant.id,
        { taskId: task.id },
        { id: revisionId, instructions: parsed.data.instructions, origin: 'api', attachments },
      );
      return { revisionId: revision.id, number: revision.number, status: revision.status };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (error instanceof RevisionRejected)
        throw error.reason === 'not_found'
          ? new NotFoundException(error.message)
          : new ConflictException(error.message);
      throw error;
    }
  }
  @Post('tenants/:tenant/tasks/:id/retry')
  @HttpCode(202)
  retry(
    @Param('tenant') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('revision') revision?: string,
  ) {
    return this.operate(tenantId, id, revision, (t, task, n) =>
      this.orchestrator.retry(t, task, n),
    );
  }
  /** Publishes a finished rehearsal: one commit with the delivery's files and a draft PR. */
  @Post('tenants/:tenant/tasks/:id/promote')
  @HttpCode(202)
  promote(@Param('tenant') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.operate(tenantId, id, undefined, (t, task) => this.orchestrator.promote(t, task));
  }
  /** Removes a coder task's folder from the company's workspace (e.g. a checked rehearsal). */
  @Post('tenants/:tenant/tasks/:id/discard')
  @HttpCode(200)
  async discard(@Param('tenant') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = this.tenant(tenantId);
    const outcome = await this.orchestrator.discard(tenant.id, id);
    if (outcome === 'not_found') throw new NotFoundException('Unknown task');
    if (outcome === 'running')
      throw new ConflictException('A tarefa ainda está rodando; cancele antes de descartar');
    if (outcome === 'local')
      throw new BadRequestException('Só tarefas em workspace coder têm pasta para descartar');
    return { discarded: true };
  }
  /** A print or the Playwright trace of the task's test evidence. */
  @Get('tenants/:tenant/tasks/:id/evidence/:file')
  async evidence(
    @Param('tenant') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('file') file: string,
    @Res() res: Response,
  ) {
    const tenant = this.tenant(tenantId);
    if (!EVIDENCE_FILE.test(file)) throw new BadRequestException('Invalid evidence file');
    const task = await this.db.getRepository(Task).findOneBy({ id, tenantId: tenant.id });
    if (!task) throw new NotFoundException('Unknown task');
    const bytes = await readFile(join(evidenceDir(tenant.id, task.id), file)).catch(
      () => undefined,
    );
    if (!bytes) throw new NotFoundException('Unknown evidence file');
    res
      .type(file.endsWith('.png') ? 'image/png' : 'application/zip')
      .setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }
  @Post('tenants/:tenant/tasks/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('tenant') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('revision') revision?: string,
  ) {
    return this.operate(tenantId, id, revision, (t, task, n) =>
      this.orchestrator.cancel(t, task, n),
    );
  }
  private async operate(
    tenantId: string,
    id: string,
    revision: string | undefined,
    action: (tenant: string, task: string, revision?: number) => Promise<Task | Revision>,
  ) {
    const tenant = this.tenant(tenantId);
    const number = revision === undefined ? undefined : Number(revision);
    if (number !== undefined && (!Number.isInteger(number) || number < 1))
      throw new BadRequestException('revision must be a positive number');
    try {
      const job = await action(tenant.id, id, number);
      return { id: job.id, revision: number, status: job.status, stage: job.stage };
    } catch (error) {
      if (error instanceof JobRejected) throw httpError(error);
      throw error;
    }
  }
  /** Decisions with the card they belong to, for any operator surface (MCP, front). */
  private async decisionViews(list: Decision[]) {
    const tasks = list.length
      ? await this.db
          .getRepository(Task)
          .findBy({ id: In([...new Set(list.map((d) => d.taskId))]) })
      : [];
    const issues = tasks.length
      ? await this.db.getRepository(Issue).findBy({ id: In(tasks.map((t) => t.issueId)) })
      : [];
    return list.map((d) => {
      const issue = issues.find((i) => i.id === tasks.find((t) => t.id === d.taskId)?.issueId);
      return {
        id: d.id,
        tenantId: d.tenantId,
        type: d.type,
        status: d.status,
        taskId: d.taskId,
        revisionId: d.revisionId,
        card: issue?.externalKey ?? null,
        title: issue?.title ?? null,
        questions: d.questions,
        reason: d.reason,
        details: d.details,
        answer: d.answer,
        createdAt: d.createdAt,
        answeredAt: d.answeredAt,
      };
    });
  }
  /**
   * Live updates for the front (SSE): every EVENTS_POLL_MS, what changed since the last push.
   * The worker is another process; the database is where its progress shows up.
   */
  @Get('events')
  async events(@Req() req: Request, @Res() res: Response) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // The database clock, not this process's: updatedAt is written by PostgreSQL.
    const [{ now }] = await this.db.query('SELECT now() AS now');
    const feed = new ChangeFeed(new Date(now));
    let busy = false;
    const tick = async (send = true) => {
      if (busy) return;
      busy = true;
      try {
        const query = {
          where: { updatedAt: MoreThan(feed.since()) },
          order: { updatedAt: 'ASC' as const },
          take: 500,
        };
        const [tasks, revisions, decisions] = await Promise.all([
          this.db.getRepository(Task).find(query),
          this.db.getRepository(Revision).find(query),
          this.db.getRepository(Decision).find(query),
        ]);
        const rows = [
          ...tasks.map((t) => ({
            type: 'task',
            id: t.id,
            taskId: t.id,
            tenantId: t.tenantId,
            status: t.status,
            stage: t.stage,
            updatedAt: t.updatedAt,
          })),
          ...revisions.map((r) => ({
            type: 'revision',
            id: r.id,
            taskId: r.taskId,
            status: r.status,
            stage: r.stage,
            updatedAt: r.updatedAt,
          })),
          ...decisions.map((d) => ({
            type: 'decision',
            id: d.id,
            taskId: d.taskId,
            tenantId: d.tenantId,
            status: d.status,
            updatedAt: d.updatedAt,
          })),
        ];
        const fresh = feed.take(rows);
        if (send)
          for (const row of fresh)
            res.write(
              `event: change\ndata: ${JSON.stringify({ ...row, updatedAt: undefined })}\n\n`,
            );
      } catch {
        // A transient database error: the next tick tries again.
      } finally {
        busy = false;
      }
    };
    // What is already in the window is the state the front loads itself: only later changes go out.
    await tick(false);
    const poll = setInterval(() => void tick(), config().EVENTS_POLL_MS);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(poll);
      clearInterval(ping);
    });
  }
  /** Starts a Jira card the operator picked (front), whatever its label or status. */
  @Post('tenants/:tenant/tasks/from-jira')
  async fromJira(
    @Param('tenant') tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenant = this.tenant(tenantId);
    const parsed = z
      .object({
        key: z.string().trim().regex(CARD_KEY),
        // A sub-task started on its own: the branch it starts from (checked by the poller).
        base: z.string().trim().max(200).regex(BRANCH).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Use a chave do card, ex.: PF-123');
    const { key, base } = parsed.data;
    return this.jira(async () => {
      const result = await (base
        ? this.poller.startFromKey(tenant.id, key, base)
        : this.poller.startFromKey(tenant.id, key));
      res.status('skipped' in result ? 200 : 202);
      return result;
    });
  }
  /** For a sub-task: the branches it may start from (story branch, existing sibling branches). */
  @Get('tenants/:tenant/jira/:key/bases')
  async subtaskBases(@Param('tenant') tenantId: string, @Param('key') key: string) {
    const tenant = this.tenant(tenantId);
    if (!CARD_KEY.test(key)) throw new BadRequestException('Use a chave do card, ex.: PF-123');
    return this.jira(() => this.poller.subtaskBases(tenant.id, key));
  }
  /** A card of a source of the company, started by its key (any source type that can). */
  @Post('tenants/:tenant/sources/:source/start')
  async startCard(
    @Param('tenant') tenantId: string,
    @Param('source') sourceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tenant, source, starter } = this.starter(tenantId, sourceId);
    const parsed = z
      .object({
        key: z.string().max(100),
        // A sub-task started on its own: the branch it starts from (checked by the source).
        base: z.string().trim().max(200).regex(BRANCH).optional(),
        // The route of the project's method, stated by the operator (sources without route tags).
        route: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .optional(),
        // A new task for a card whose last task published nothing (the earlier one is kept).
        again: z.boolean().optional(),
      })
      .safeParse(body);
    const key = parsed.success ? normalizeCardKey(starter.key, parsed.data.key) : undefined;
    if (!parsed.success || !key)
      throw new BadRequestException(`Use a chave do card, ex.: ${starter.example}`);
    const { base, route, again } = parsed.data;
    if (route && !starter.routes)
      throw new BadRequestException('Esta origem não recebe rota ao iniciar o card');
    return this.jira(async () => {
      const result = await (again
        ? starter.start(tenant, source, key, base, route, true)
        : route
          ? starter.start(tenant, source, key, base, route)
          : base
            ? starter.start(tenant, source, key, base)
            : starter.start(tenant, source, key));
      res.status('skipped' in result ? 200 : 202);
      return result;
    });
  }
  /** What the company learned on this project (lessons/ in its pack), as agents receive it. */
  @Get('tenants/:tenant/projects/:project/lessons')
  async lessons(@Param('tenant') tenantId: string, @Param('project') projectId: string) {
    const tenant = this.projectOf(tenantId, projectId);
    const open = await this.db
      .getRepository(LessonSuggestion)
      .find({ where: { tenantId: tenant.id, projectKey: projectId, status: 'open' } });
    return {
      lessons: projectLessons(tenant.packDir, projectId),
      pack: !!tenant.packDir,
      // Noticed by the system: answered stops at once, bare failures once they repeat.
      suggestions: open
        .filter(visible)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((x) => ({
          id: x.id,
          problem: x.problem,
          answer: x.answer,
          count: x.count,
          text: lessonText(x),
          taskIds: x.taskIds,
        })),
    };
  }
  /** A lesson the operator records (from a failure or a stop): appended to the pack, uncommitted. */
  @Post('tenants/:tenant/projects/:project/lessons')
  async addLesson(
    @Param('tenant') tenantId: string,
    @Param('project') projectId: string,
    @Body() body: unknown,
  ) {
    const tenant = this.projectOf(tenantId, projectId);
    if (!tenant.packDir) throw new BadRequestException('Lições ficam no pack da empresa');
    const parsed = z
      .object({ text: z.string().trim().min(3).max(1000), taskId: z.uuid().optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Escreva a lição (3 a 1000 caracteres)');
    const task = parsed.data.taskId
      ? await this.db.getRepository(Task).findOneBy({ id: parsed.data.taskId, tenantId: tenant.id })
      : null;
    const issue = task ? await this.db.getRepository(Issue).findOneBy({ id: task.issueId }) : null;
    const origin = [issue?.externalKey, new Date().toISOString().slice(0, 10)]
      .filter(Boolean)
      .join(', ');
    const lesson = addLesson(tenant.packDir, projectId, parsed.data.text, origin);
    return { lesson, lessons: projectLessons(tenant.packDir, projectId) };
  }
  /** A suggested lesson: saved into the pack (as the operator worded it) or dismissed for good. */
  @Post('tenants/:tenant/projects/:project/lessons/suggestions/:id')
  @HttpCode(200)
  async ruleSuggestion(
    @Param('tenant') tenantId: string,
    @Param('project') projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const tenant = this.projectOf(tenantId, projectId);
    const parsed = z
      .union([
        z.object({ action: z.literal('save'), text: z.string().trim().min(3).max(1000) }),
        z.object({ action: z.literal('dismiss') }),
      ])
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Use save (com o texto) ou dismiss');
    const repo = this.db.getRepository(LessonSuggestion);
    const found = await repo.findOneBy({ id, tenantId: tenant.id, projectKey: projectId });
    if (!found) throw new NotFoundException('Sugestão desconhecida');
    if (parsed.data.action === 'dismiss') {
      await repo.update(id, { status: 'dismissed' });
      return { status: 'dismissed' };
    }
    if (!tenant.packDir) throw new BadRequestException('Lições ficam no pack da empresa');
    const lesson = addLesson(
      tenant.packDir,
      projectId,
      parsed.data.text,
      `sugestão, ${found.count}x, ${new Date().toISOString().slice(0, 10)}`,
    );
    await repo.update(id, { status: 'saved' });
    return { status: 'saved', lesson, lessons: projectLessons(tenant.packDir, projectId) };
  }
  private projectOf(tenantId: string, projectId: string) {
    const tenant = this.tenant(tenantId);
    if (!tenant.projects.some((p) => p.id === projectId))
      throw new NotFoundException('Projeto desconhecido');
    return tenant;
  }
  /** For a sub-task of a source that has them: the branches it may start from. */
  @Get('tenants/:tenant/sources/:source/cards/:key/bases')
  async cardBases(
    @Param('tenant') tenantId: string,
    @Param('source') sourceId: string,
    @Param('key') raw: string,
  ) {
    const { tenant, source, starter } = this.starter(tenantId, sourceId);
    if (!starter.bases) throw new NotFoundException('Esta origem não tem bases de sub-tarefa');
    const key = normalizeCardKey(starter.key, raw);
    if (!key) throw new BadRequestException(`Use a chave do card, ex.: ${starter.example}`);
    return this.jira(() => starter.bases!(tenant, source, key));
  }
  private startsCards(tenantId: string, sourceId: string) {
    const source = findTenant(tenantId)?.sources.find((s) => s.id === sourceId);
    return !!source && !!this.starters?.for(source);
  }
  private starter(tenantId: string, sourceId: string) {
    const tenant = this.tenant(tenantId);
    const source = tenant.sources.find((s) => s.id === sourceId);
    const starter = source && this.starters?.for(source);
    if (!source || !starter) throw new NotFoundException('Origem desconhecida');
    return { tenant, source, starter };
  }
  /** Source and code host failures as HTTP: no Jira source is 404, anything else 502 (redacted). */
  private async jira<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Empresa sem fonte Jira') throw new NotFoundException(message);
      // The operator's own request refused (a card that cannot be restarted): not the source's.
      if (error instanceof TaskError && !error.retryable)
        throw new ConflictException(redact(message).slice(0, 500));
      throw new HttpException(redact(message).slice(0, 500), 502);
    }
  }
  @Get('tenants/:tenant/decisions')
  async decisions(@Param('tenant') tenantId: string, @Query('status') status?: string) {
    const tenant = this.tenant(tenantId);
    const list = await this.db.getRepository(Decision).find({
      where: { tenantId: tenant.id, ...(status === 'all' ? {} : { status: 'open' as const }) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return this.decisionViews(list);
  }
  @Post('tenants/:tenant/decisions/:id/answer')
  @HttpCode(200)
  async answerDecision(
    @Param('tenant') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: OperatorRequest,
  ) {
    const tenant = this.tenant(tenantId);
    const parsed = decisionAnswer.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Send answers[], or action retry / cancel / retry_with_instructions (with instructions)',
      );
    try {
      const decision = await this.orchestrator.answerDecision(
        tenant.id,
        id,
        parsed.data as DecisionAnswer,
        req.operatorVia === 'web' ? 'web' : 'api',
      );
      return (await this.decisionViews([decision]))[0];
    } catch (error) {
      if (error instanceof JobRejected) throw httpError(error);
      throw error;
    }
  }
  @Get('tenants/:tenant/tasks')
  async list(@Param('tenant') tenantId: string, @Query('limit') limit?: string) {
    const tenant = this.tenant(tenantId);
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const tasks = await this.db
      .getRepository(Task)
      .find({ where: { tenantId: tenant.id }, order: { createdAt: 'DESC' }, take });
    return this.present(tasks);
  }
  @Get('tenants/:tenant/tasks/:id')
  async get(@Param('tenant') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = this.tenant(tenantId);
    // Filtering by tenant: another company's task id answers exactly like a missing one.
    const task = await this.db.getRepository(Task).findOneBy({ id, tenantId: tenant.id });
    if (!task) throw new NotFoundException('Unknown task');
    const [view] = await this.present([task]);
    const runs = await this.db
      .getRepository(AgentRun)
      .find({ where: { taskId: task.id }, order: { startedAt: 'ASC' }, take: 200 });
    const decisions = await this.db.getRepository(Decision).findBy({ taskId: task.id });
    // Commands and output can carry prompts and secrets: only what happened, and when.
    return {
      ...view,
      metrics: taskMetrics(task, runs, decisions),
      runs: runs.map((r) => ({
        agent: r.agent,
        provider: r.provider,
        status: r.status,
        exitCode: r.exitCode,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        ...(r.phase ? { phase: r.phase } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      })),
    };
  }
  private async present(tasks: Task[]) {
    const issues = tasks.length
      ? await this.db.getRepository(Issue).findBy({ id: In(tasks.map((t) => t.issueId)) })
      : [];
    const byId = new Map(issues.map((i) => [i.id, i]));
    const projects = issues.length
      ? await this.db
          .getRepository(Project)
          .findBy({ id: In([...new Set(issues.map((i) => i.projectId))]) })
      : [];
    const revisions = tasks.length
      ? await this.db
          .getRepository(Revision)
          .find({ where: { taskId: In(tasks.map((t) => t.id)) }, order: { number: 'ASC' } })
      : [];
    const decisions = tasks.length
      ? await this.db
          .getRepository(Decision)
          .find({ where: { taskId: In(tasks.map((t) => t.id)) }, order: { createdAt: 'ASC' } })
      : [];
    return tasks.map((t) => {
      const issue = byId.get(t.issueId);
      return {
        id: t.id,
        tenantId: t.tenantId,
        project: projects.find((p) => p.id === issue?.projectId)?.key,
        branch: t.branch,
        key: issue?.externalKey,
        title: issue?.title,
        source: issue?.source,
        url: issue?.url || undefined,
        status: t.status,
        stage: t.stage,
        provider: t.provider,
        attempts: t.attempts,
        error: t.error,
        costUsd: Number(t.costUsd ?? 0),
        // Restarted by the operator: the card's newer task.
        supersededBy: t.result?.supersededBy,
        // The operator may start the card again (its source starts cards, nothing published).
        restartable:
          !!issue &&
          this.startsCards(t.tenantId, issue.source) &&
          !t.result?.supersededBy &&
          !restartRefusal(t, !!t.result?.prUrl),
        usage: t.usage ?? undefined,
        // Per agent of the method, as its own telemetry counted it.
        methodTelemetry: t.result?.methodTelemetry,
        prUrl: t.result?.prUrl,
        agentAttempts: t.result?.agentAttempts,
        // Rehearsal (nothing published): where to look in the company's workspace.
        rehearsal: t.result?.rehearsal,
        discarded: t.result?.discarded,
        // Test evidence for the audit: prints (served one by one) and the comment to paste.
        evidence: evidenceView(t.result?.evidence),
        revisions: revisions
          .filter((r) => r.taskId === t.id)
          .map((r) => ({
            id: r.id,
            number: r.number,
            instructions: r.instructions.slice(0, 500),
            origin: r.origin,
            requestedBy: r.requestedBy ?? undefined,
            status: r.status,
            stage: r.stage,
            error: r.error,
            commitSha: r.result?.commitSha,
            agentAttempts: r.result?.agentAttempts,
            createdAt: r.createdAt,
          })),
        attachments: issue?.attachments?.map((a) => a.name) ?? [],
        review: t.result?.review,
        checks: t.result?.checks,
        decisions: decisions
          .filter((d) => d.taskId === t.id)
          .map((d) => ({
            id: d.id,
            type: d.type,
            status: d.status,
            revisionId: d.revisionId,
            createdAt: d.createdAt,
          })),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
  }
}
