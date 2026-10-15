import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config, log } from '../../config';
import {
  attachmentsDir,
  IncomingFile,
  revisionFolder,
  saveAttachments,
} from '../../attachments/attachments';
import { Issue, Project, PullRequest, StepPlan, StoryPlan, Task } from '../../database/entities';
import { CodeHost, ReviewComment } from '../../hosts/code-host';
import { createHost } from '../../tenants/tenant-registry.service';
import { renderBranch } from '../../tasks/branch';
import { OrchestratorService } from '../../tasks/orchestrator.service';
import { JiraSource, Tenant, tenants } from '../../tenants/tenants';
import { SourceReporter } from '../source-reporter.service';
import { adfToText } from './adf';
import { JiraClient, JiraIssue } from './jira.client';
/** What starting a card produced: its task, or why there is none (with the existing task). */
export type IngestResult = { taskId: string } | { skipped: string; taskId?: string };
/** A branch a sub-task started on its own may begin from. */
export interface SubtaskBase {
  branch: string;
  label: string;
  /** Last commit date, from the code host. */
  date: string;
}
export type SubtaskBases =
  | { subtask: false }
  | {
      subtask: true;
      story: string;
      storyBranch: string;
      ownBranch?: string;
      ownExists: boolean;
      bases: SubtaskBase[];
    };
/** Polls each Jira source's JQL: no public URL or Jira admin webhook needed. */
@Injectable()
export class JiraPoller implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private readonly unmapped = new Set<string>();
  /** Ingests of one source, one at a time (polling and the front share the API process). */
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: DataSource,
    private readonly orchestrator: OrchestratorService,
    private readonly reporter: SourceReporter,
  ) {}
  /** Overridable in tests. */
  protected client(source: JiraSource) {
    return new JiraClient(source);
  }
  onModuleInit() {
    if (!config().SOURCE_POLLING) return;
    for (const tenant of tenants())
      for (const source of tenant.sources)
        if (source.type === 'jira') {
          void this.poll(tenant, source);
          this.timers.push(
            setInterval(() => void this.poll(tenant, source), source.pollSeconds * 1000),
          );
        }
  }
  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }
  async poll(tenant: Tenant, source: JiraSource) {
    // Session lock: with several API replicas only one polls a source at a time, and a slow
    // poll is never overlapped by the next tick.
    const lock = this.db.createQueryRunner();
    await lock.connect();
    const key = `poll:${tenant.id}/${source.id}`;
    try {
      const [{ locked }] = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
        key,
      ]);
      if (!locked) return;
      try {
        const client = this.client(source);
        const found = await client.search();
        await this.exclusive(`${tenant.id}/${source.id}`, async () => {
          for (const issue of found)
            await this.ingest(tenant, source, client, issue).catch((error: unknown) =>
              log('jira.ingest_failed', {
                tenant: tenant.id,
                source: source.id,
                key: issue.key,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        });
        await this.changeRequests(tenant, source, client).catch((error: unknown) =>
          log('jira.change_requests_failed', {
            tenant: tenant.id,
            source: source.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } catch (error) {
      log('jira.poll_failed', {
        tenant: tenant.id,
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await lock.release();
    }
  }
  async ingest(
    tenant: Tenant,
    source: JiraSource,
    client: JiraClient,
    issue: JiraIssue,
  ): Promise<IngestResult> {
    // Cards stay in the JQL until someone moves them: already accepted ones cost one lookup.
    if (!/^\d+$/.test(issue.id)) throw new Error(`Unexpected Jira issue id ${issue.id}`);
    // Sub-tasks are steps of their parent's delivery (label the story), never tasks of their own.
    if (source.subtasks !== 'separate' && issue.fields.issuetype?.subtask)
      return { skipped: 'O card é uma sub-tarefa: inicie pela história' };
    const existing = await this.db
      .getRepository(Issue)
      .findOneBy({ tenantId: tenant.id, source: source.id, externalId: issue.id });
    if (existing) {
      const task = await this.db.getRepository(Task).findOneBy({ issueId: existing.id });
      return { skipped: 'Esse card já tem tarefa', taskId: task?.id };
    }
    const projectKey = issue.fields.project?.key ?? issue.key.split('-')[0];
    const project = source.projects[projectKey] ?? source.defaultProject;
    if (!project) {
      if (!this.unmapped.has(issue.key))
        log('jira.unmapped_project', { tenant: tenant.id, source: source.id, key: issue.key });
      this.unmapped.add(issue.key);
      return { skipped: `Projeto ${projectKey} não está mapeado em tenants.yaml` };
    }
    const all = issue.fields.subtasks ?? [];
    const open = all.filter((ref) => ref.fields?.status?.statusCategory?.key !== 'done');
    if (source.subtasks === 'branch-per-subtask' && all.length) {
      // The story has no task of its own: it was taken once any of its sub-tasks was (it
      // stays in the JQL while they run, and after they are done).
      const taken = await this.db.getRepository(Issue).existsBy({
        tenantId: tenant.id,
        source: source.id,
        externalId: In(all.map((r) => r.id)),
      });
      if (taken) return { skipped: 'Essa história já está em andamento' };
      if (!open.length) return { skipped: 'A história não tem sub-tarefas abertas' };
      return this.ingestStory(
        tenant,
        source,
        client,
        issue,
        project,
        open.map((r) => r.key),
      );
    }
    const dir = attachmentsDir(tenant.id, source.id, issue.id);
    // Leftovers of an ingest that crashed before the task existed belong to no task.
    await rm(dir, { recursive: true, force: true });
    const parent = await this.content(source, client, issue, dir);
    // Open sub-tasks, in the card's order, become the delivery steps.
    const steps: StepPlan[] = [];
    if (source.subtasks === 'same-pr')
      for (const ref of open) {
        const sub = await client.issue(ref.key);
        const revisionId = randomUUID();
        // Step 0 is the task itself; later steps are revisions with their own file folder.
        const folder = steps.length === 0 ? `sub-${sub.key}` : revisionFolder(revisionId);
        const own = await this.content(source, client, sub, join(dir, folder));
        steps.push({
          externalId: sub.id,
          key: sub.key,
          title: (sub.fields.summary || sub.key).slice(0, 256),
          body: own.body,
          revisionId,
          attachments:
            steps.length === 0
              ? own.attachments.map((a) => ({ ...a, name: `${folder}/${a.name}` }))
              : own.attachments,
        });
      }
    const task = await this.orchestrator.accept(tenant.id, {
      source: source.id,
      externalId: issue.id,
      key: issue.key,
      title: (issue.fields.summary || issue.key).slice(0, 256),
      body: parent.body,
      url: `${source.baseUrl}/browse/${issue.key}`,
      project,
      // The first step's files travel with the task, next to the parent's.
      attachments: [...parent.attachments, ...(steps[0]?.attachments ?? [])],
      steps,
    });
    log('jira.accepted', {
      tenant: tenant.id,
      source: source.id,
      key: issue.key,
      taskId: task.id,
      steps: steps.map((s) => s.key),
    });
    await this.reporter.report(
      tenant,
      { source: source.id, externalKey: issue.key },
      { type: 'accepted', taskId: task.id, steps: steps.map((s) => s.key) },
    );
    if (steps[0])
      await this.reporter.report(
        tenant,
        { source: source.id, externalKey: steps[0].key },
        { type: 'step-started' },
      );
    return { taskId: task.id };
  }
  private jira(tenantId: string) {
    const tenant = tenants().find((t) => t.id === tenantId);
    const source = tenant?.sources.find((s): s is JiraSource => s.type === 'jira');
    if (!tenant || !source) throw new Error('Empresa sem fonte Jira');
    return { tenant, source, client: this.client(source) };
  }
  /**
   * The operator picked this card (front): ingested like a polled one, whatever the JQL says.
   * A sub-task of a branch-per-subtask story starts on its own, from the chosen `base`.
   */
  async startFromKey(tenantId: string, key: string, base?: string): Promise<IngestResult> {
    const { tenant, source } = this.jira(tenantId);
    return this.startIn(tenant, source, key, base);
  }
  /** The same, on a given Jira source of the company (a company may have several). */
  async startIn(
    tenant: Tenant,
    source: JiraSource,
    key: string,
    base?: string,
  ): Promise<IngestResult> {
    const client = this.client(source);
    const issue = await client.issue(key);
    return this.exclusive(`${tenant.id}/${source.id}`, () =>
      issue.fields.issuetype?.subtask && source.subtasks === 'branch-per-subtask'
        ? this.startSubtask(tenant, source, client, issue, base)
        : this.ingest(tenant, source, client, issue),
    );
  }
  /** Where a sub-task started on its own may begin: the story branch or a sibling's. */
  async subtaskBases(tenantId: string, key: string): Promise<SubtaskBases> {
    const { tenant, source } = this.jira(tenantId);
    return this.basesIn(tenant, source, key);
  }
  async basesIn(tenant: Tenant, source: JiraSource, key: string): Promise<SubtaskBases> {
    const client = this.client(source);
    const issue = await client.issue(key);
    if (!issue.fields.issuetype?.subtask || source.subtasks !== 'branch-per-subtask')
      return { subtask: false };
    const ctx = await this.subtaskContext(tenant, source, client, issue);
    return {
      subtask: true,
      story: ctx.story.key,
      storyBranch: ctx.storyBranch,
      ...(ctx.ownBranch ? { ownBranch: ctx.ownBranch } : {}),
      ownExists: ctx.ownExists,
      bases: ctx.bases,
    };
  }
  private async subtaskContext(
    tenant: Tenant,
    source: JiraSource,
    client: JiraClient,
    issue: JiraIssue,
  ) {
    const storyKey = issue.fields.parent?.key;
    if (!storyKey) throw new Error('A sub-tarefa não tem história (pai)');
    const story = await client.issue(storyKey);
    const projectKey = story.fields.project?.key ?? story.key.split('-')[0];
    const project = source.projects[projectKey] ?? source.defaultProject;
    if (!project) throw new Error(`Projeto ${projectKey} não está mapeado em tenants.yaml`);
    const cfg = tenant.projects.find((p) => p.id === project)!;
    const { host, repository } = this.host(tenant, project);
    // Same name the story delivery would give it (ingestStory).
    const storyBranch = renderBranch(cfg.branch, story.key, `story-${story.id}`);
    // With {id} in the pattern, sub-task branch names are not known in advance.
    const named = (key: string) =>
      cfg.branch.includes('{id}') ? undefined : renderBranch(cfg.branch, key, '');
    const candidates = [
      { branch: storyBranch, label: `História ${story.key}` },
      ...(story.fields.subtasks ?? [])
        .filter((s) => s.key !== issue.key && named(s.key))
        .map((s) => ({
          branch: named(s.key)!,
          label: s.fields?.summary ? `${s.key} — ${s.fields.summary}` : s.key,
        })),
    ];
    const dates = await Promise.all(candidates.map((c) => host.branchDate(repository, c.branch)));
    const bases = candidates
      .map((c, i) => ({ ...c, date: dates[i] }))
      .filter((c): c is SubtaskBase => !!c.date);
    const ownBranch = named(issue.key);
    const ownExists = ownBranch ? !!(await host.branchDate(repository, ownBranch)) : false;
    return { story, project, storyBranch, ownBranch, ownExists, bases };
  }
  /**
   * One sub-task on its own (the operator chose it and its base): its branch starts from `base`,
   * its PR goes to the story branch, the story travels as context; the other sub-tasks are
   * untouched and nothing is queued after it.
   */
  private async startSubtask(
    tenant: Tenant,
    source: JiraSource,
    client: JiraClient,
    issue: JiraIssue,
    base?: string,
  ): Promise<IngestResult> {
    const existing = await this.db
      .getRepository(Issue)
      .findOneBy({ tenantId: tenant.id, source: source.id, externalId: issue.id });
    if (existing) {
      const task = await this.db.getRepository(Task).findOneBy({ issueId: existing.id });
      return { skipped: 'Esse card já tem tarefa', taskId: task?.id };
    }
    const ctx = await this.subtaskContext(tenant, source, client, issue);
    if (!ctx.bases.some((b) => b.branch === ctx.storyBranch))
      return { skipped: `A branch da história (${ctx.storyBranch}) não existe no repositório` };
    if (ctx.ownExists)
      return {
        skipped: `Já existe a branch ${ctx.ownBranch} no repositório: a sub-tarefa já foi começada`,
      };
    if (!base) return { skipped: 'Escolha de qual branch a sub-tarefa começa' };
    if (!ctx.bases.some((b) => b.branch === base))
      return { skipped: `A branch ${base} não é a da história nem a de uma sub-tarefa irmã` };
    const dir = attachmentsDir(tenant.id, source.id, issue.id);
    await rm(dir, { recursive: true, force: true });
    const own = await this.content(source, client, issue, dir);
    const parent = await this.content(source, client, ctx.story, join(dir, 'story'));
    const step: StepPlan = {
      externalId: issue.id,
      key: issue.key,
      title: (issue.fields.summary || issue.key).slice(0, 256),
      body: own.body,
      revisionId: randomUUID(),
      attachments: [
        ...own.attachments,
        ...parent.attachments.map((a) => ({ ...a, name: `story/${a.name}` })),
      ],
    };
    const task = await this.orchestrator.accept(tenant.id, {
      source: source.id,
      externalId: issue.id,
      key: issue.key,
      title: step.title,
      body: step.body,
      url: `${source.baseUrl}/browse/${issue.key}`,
      project: ctx.project,
      attachments: step.attachments,
      delivery: {
        baseRef: base,
        prTarget: ctx.storyBranch,
        single: true,
        stepIndex: 0,
        story: {
          key: ctx.story.key,
          externalId: ctx.story.id,
          title: (ctx.story.fields.summary || ctx.story.key).slice(0, 256),
          body: parent.body,
          branch: ctx.storyBranch,
          steps: [step],
        },
      },
    });
    log('jira.accepted', {
      tenant: tenant.id,
      source: source.id,
      key: issue.key,
      taskId: task.id,
      single: true,
      base,
    });
    await this.reporter.report(
      tenant,
      { source: source.id, externalKey: issue.key },
      { type: 'accepted', taskId: task.id },
    );
    return { taskId: task.id };
  }
  /**
   * Runs work for one source after any ingest already running for it: two starts of the same
   * card (a double tap, or the front racing the poll) never download into the same folder at
   * once, and the second finds the first one's task.
   */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.running.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.running.get(key) === next) this.running.delete(key);
    }
  }
  /**
   * branch-per-subtask: the story gets a branch (created from the default branch by its first
   * sub-task) and each open sub-task, in order, a branch stacked on the previous one with a PR
   * into the story branch. Only the first is queued now; each next one starts when the previous
   * opens its PR.
   */
  private async ingestStory(
    tenant: Tenant,
    source: JiraSource,
    client: JiraClient,
    issue: JiraIssue,
    project: string,
    keys: string[],
  ): Promise<IngestResult> {
    const subs = [];
    for (const key of keys) subs.push(await client.issue(key));
    const cfg = tenant.projects.find((p) => p.id === project)!;
    // The story's own files go once to a staging folder, then next to each sub-task's.
    const storyDir = attachmentsDir(tenant.id, source.id, issue.id);
    await rm(storyDir, { recursive: true, force: true });
    const parent = await this.content(source, client, issue, join(storyDir, 'story'));
    const steps: StepPlan[] = [];
    for (const sub of subs) {
      const dir = attachmentsDir(tenant.id, source.id, sub.id);
      await rm(dir, { recursive: true, force: true });
      const own = await this.content(source, client, sub, dir);
      if (parent.attachments.length)
        await cp(join(storyDir, 'story'), join(dir, 'story'), { recursive: true });
      steps.push({
        externalId: sub.id,
        key: sub.key,
        title: (sub.fields.summary || sub.key).slice(0, 256),
        body: own.body,
        revisionId: randomUUID(),
        attachments: [
          ...parent.attachments.map((a) => ({ ...a, name: `story/${a.name}` })),
          ...own.attachments,
        ],
      });
    }
    await rm(storyDir, { recursive: true, force: true });
    const story: StoryPlan = {
      key: issue.key,
      externalId: issue.id,
      title: (issue.fields.summary || issue.key).slice(0, 256),
      body: parent.body,
      branch: renderBranch(cfg.branch, issue.key, `story-${issue.id}`),
      steps,
    };
    const first = steps[0];
    const task = await this.orchestrator.accept(tenant.id, {
      source: source.id,
      externalId: first.externalId,
      key: first.key,
      title: first.title,
      body: first.body,
      url: `${source.baseUrl}/browse/${first.key}`,
      project,
      attachments: first.attachments,
      delivery: {
        baseRef: story.branch,
        prTarget: story.branch,
        ensureBase: true,
        story,
        stepIndex: 0,
      },
    });
    log('jira.accepted', {
      tenant: tenant.id,
      source: source.id,
      key: issue.key,
      taskId: task.id,
      storyBranch: story.branch,
      steps: steps.map((s) => s.key),
    });
    await this.reporter.report(
      tenant,
      { source: source.id, externalKey: issue.key },
      { type: 'accepted', taskId: task.id, steps: steps.map((s) => s.key), stacked: true },
    );
    await this.reporter.report(
      tenant,
      { source: source.id, externalKey: first.key },
      { type: 'step-started' },
    );
    return { taskId: task.id };
  }
  /** Description as text plus downloaded attachments (skipped ones noted in the text). */
  private async content(source: JiraSource, client: JiraClient, issue: JiraIssue, dir: string) {
    const notes: string[] = [];
    const files: IncomingFile[] = [];
    for (const attachment of issue.fields.attachment ?? []) {
      if (files.length >= config().ATTACHMENT_MAX_FILES) {
        notes.push(`Anexo ${attachment.filename} ignorado: limite de ${files.length} arquivos.`);
        continue;
      }
      try {
        files.push({
          originalname: attachment.filename,
          mimetype: attachment.mimeType ?? '',
          buffer: await client.download(attachment, config().ATTACHMENT_MAX_BYTES),
        });
      } catch (error) {
        notes.push(
          `Anexo ${attachment.filename} ignorado: ${error instanceof Error ? error.message : error}.`,
        );
      }
    }
    return {
      body: [this.text(source, issue.fields.description), ...notes].filter(Boolean).join('\n\n'),
      attachments: await saveAttachments(dir, files),
    };
  }
  private text(source: JiraSource, value: unknown) {
    if (source.deployment === 'cloud') return adfToText(value);
    return typeof value === 'string' ? value : '';
  }
  /** Code host of the issue's project; overridable in tests. */
  protected host(tenant: Tenant, projectKey: string): { repository: string; host: CodeHost } {
    const cfg = tenant.projects.find((p) => p.id === projectKey);
    const host = cfg && tenant.hosts.find((h) => h.id === cfg.host);
    if (!cfg || !host) throw new Error(`Unknown project ${projectKey}`);
    return { repository: cfg.repository, host: createHost(host) };
  }
  /**
   * Cards of this source whose PR exists and that reviewers moved to the change-request
   * status: their new comments — on the card and on the pull request, including comments on
   * lines of code — become one revision of the same PR. Our own comments (all start with
   * "AI Dev Team"), resolved and deleted ones are left out; each comment is used once.
   */
  async changeRequests(tenant: Tenant, source: JiraSource, client: JiraClient) {
    const status = source.transitions.changeRequest;
    if (!status) return;
    const candidates = await this.db
      .getRepository(Issue)
      .createQueryBuilder('i')
      .innerJoin(Task, 't', 't."issueId" = i.id')
      .innerJoin(PullRequest, 'p', 'p."taskId" = t.id')
      .where('i."tenantId" = :tenant AND i.source = :source AND t.status = :done', {
        tenant: tenant.id,
        source: source.id,
        done: 'SUCCESS',
      })
      .orderBy('i."updatedAt"', 'DESC')
      .limit(50)
      .getMany();
    if (!candidates.length) return;
    const keys = candidates
      .map((i) => i.externalKey)
      .filter((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k));
    if (!keys.length) return;
    const jql = `key in (${keys.join(',')}) AND status = "${status.replace(/["\\]/g, '')}"`;
    for (const card of await client.search(50, jql)) {
      const issue = candidates.find((i) => i.externalId === card.id);
      if (!issue) continue;
      const task = await this.db.getRepository(Task).findOneByOrFail({ issueId: issue.id });
      const last = Number(issue.meta?.lastCommentId ?? 0);
      const fresh = (await client.comments(card.key))
        .filter((c) => Number(c.id) > last)
        .map((c) => ({ ...c, text: this.text(source, c.body).trim() }))
        .filter((c) => c.text && !c.text.startsWith('AI Dev Team'))
        .reverse();
      // The review itself usually happens on the pull request. A failure to read it defers
      // the card to the next poll instead of applying half of what the reviewer asked.
      let review: ReviewComment[];
      let pr: PullRequest;
      try {
        pr = await this.db.getRepository(PullRequest).findOneByOrFail({ taskId: task.id });
        const project = await this.db
          .getRepository(Project)
          .findOneByOrFail({ id: issue.projectId });
        const { host, repository } = this.host(tenant, project.key);
        review = (
          await host.pullRequestComments(repository, pr.number, issue.meta?.lastPrCommentAt)
        ).filter(
          (c) =>
            c.body.trim() &&
            !c.body.trim().startsWith('AI Dev Team') &&
            (!c.bot ||
              !!tenant.projects.find((p) => p.id === project.key)?.pullRequest.botComments),
        );
      } catch (error) {
        log('jira.change_request_deferred', {
          tenant: tenant.id,
          key: card.key,
          reason: `pull request comments: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (!fresh.length && !review.length) continue;
      const newest = fresh.length
        ? String(Math.max(...fresh.map((c) => Number(c.id))))
        : issue.meta?.lastCommentId;
      const newestPr = review.length
        ? review[review.length - 1].createdAt
        : issue.meta?.lastPrCommentAt;
      const sections = [
        review.length
          ? `Comentários do code review no PR #${pr.number}:\n${review
              .map(
                (c) =>
                  `- ${c.reply ? '↳ resposta de ' : ''}${c.author}${c.path ? ` em \`${c.path}\`${c.line ? `, linha ${c.line}` : ''}` : ''}: ${c.body.trim()}`,
              )
              .join('\n')}`
          : '',
        fresh.length
          ? `Comentários no card ${card.key}:\n${fresh
              .map((c) => `${c.author ?? 'Revisor'} (${c.created}):\n${c.text}`)
              .join('\n\n---\n\n')}`
          : '',
      ].filter(Boolean);
      const authors = [...new Set([...review.map((c) => c.author), ...fresh.map((c) => c.author)])];
      try {
        const revision = await this.orchestrator.requestRevision(
          tenant.id,
          { taskId: task.id },
          {
            origin: 'jira-change-request',
            externalId: `jira-cr:${card.id}:${newest ?? 0}:${newestPr ?? 0}`,
            requestedBy: authors.filter(Boolean).join(', ') || undefined,
            instructions: sections.join('\n\n'),
          },
        );
        await this.db.getRepository(Issue).update(issue.id, {
          meta: { ...issue.meta, lastCommentId: newest, lastPrCommentAt: newestPr },
        });
        await this.reporter.report(
          tenant,
          { source: source.id, externalKey: card.key },
          { type: 'change-request', revision: revision.number },
        );
      } catch (error) {
        // Not ready (steps still running) or over the limit: retried on the next poll.
        log('jira.change_request_deferred', {
          tenant: tenant.id,
          key: card.key,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
