import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { log, TaskError } from '../config';
import { Decision, Task } from '../database/entities';
import type { DecisionQuestion } from '../database/entities';
import { auditable } from '../agents/process-runner.service';
import type { AgentRouter } from '../agents/agent-router.service';
import type { GitService } from '../git/git.service';
import { fillTemplate, TemplateValues } from '../prompts/prompt-files';
import { parseTag } from '../tasks/pr-description';
import { NeedsInput } from '../tasks/decisions';
import type { TaskWorkspace } from '../workspaces/task-workspace';
import type { CoderWorkspace } from '../workspaces/coder-workspace';
import type { Tenant, TenantProject } from '../tenants/tenants';
import { isApproval } from './approval';
import { loadMethod, Method, MethodRoute, methodOptions, routeOf } from './method';
/** Where a task of a method stands; kept in the job result so a resumed run redoes nothing. */
export interface MethodState {
  phase: string;
  /** The operator's own words chosen at an ask (quoted to the agent as {{AUTHORIZATION}}). */
  authorization?: string;
  /** Adjustments: answers to an ask that were not its option, and answers routed to notes. */
  notes?: string[];
  /** The operator's answers to the agent's stops. */
  answers?: string[];
  /** Text of the open question, and which step asked it, to read its answer back. */
  asked?: string;
  askedBy?: 'answers' | 'notes' | 'ask';
}
export interface RunnerContext {
  tenant: Tenant;
  cfg: TenantProject;
  ws: TaskWorkspace;
  remote: Parameters<GitService['prepare']>[2];
}
export interface RunnerDeps {
  db: DataSource;
  git: Pick<GitService, 'git' | 'prepare' | 'commitPaths' | 'changedSince' | 'push'>;
  router: Pick<AgentRouter, 'run'>;
  stage(task: Task, stage: string): Promise<void>;
  record(task: Task, attempts: unknown, provider: string): void;
  /** The project's tests and checks (the core's own steps). */
  tests(): Promise<void>;
  /** The test evidence step (when the project asks for it). */
  evidence(route: string): Promise<void>;
}
/**
 * "concluido" only when the agent says so; a missing mark is a stop, never a delivery. A stop may
 * bring the person's choices in <opcoes> (one per line, each a complete answer): at most four.
 */
export function readOutcome(
  message?: string,
): { done: true } | { done: false; pending: string; options: string[] } {
  if (parseTag(message, 'resultado')?.trim() === 'concluido') return { done: true };
  const pending = parseTag(message, 'pendencias')?.trim() || message?.trim().slice(-3000);
  const options = (parseTag(message, 'opcoes') ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line, i, all) => line && all.indexOf(line) === i)
    .slice(0, 4);
  return { done: false, pending: pending || '(sem relatório)', options };
}
/** Paths of `git status --porcelain -z --untracked-files=all` (renames: the new path). */
export function porcelainPaths(output: string) {
  const entries = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    paths.push(entries[i].slice(3));
    if (entries[i][0] === 'R' || entries[i][0] === 'C') i++;
  }
  return paths;
}
/** Whether a repository path sits under a folder. */
export function under(path: string, root: string) {
  const r = root.replace(/^\.\/|\/+$/g, '');
  return r === '' || r === '.' || path === r || path.startsWith(`${r}/`);
}
const HOOKS_DIR = '.ai-dev-team/method';
/** The state of a task of a method (result.method). */
export function methodState(
  result: Record<string, unknown> | null | undefined,
): MethodState | undefined {
  return (result?.method as MethodState | undefined) ?? undefined;
}
/**
 * Git in the hooks runs with the core's own safety settings: no git hooks, no system or global
 * configuration (credential helpers, filters), no signing, never an interactive prompt.
 */
const GIT_SAFETY: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'commit.gpgsign',
  GIT_CONFIG_VALUE_2: 'false',
};
/** Runs a company method (methods/<name>/ of its pack) for one task. */
export class MethodRunner {
  readonly method: Method;
  readonly routeId: string;
  readonly route: MethodRoute;
  private vars: Record<string, unknown> = {};
  private uploaded = false;
  constructor(
    private readonly deps: RunnerDeps,
    private readonly task: Task,
    private readonly ctx: RunnerContext,
    route: string | undefined,
  ) {
    this.method = loadMethod(ctx.tenant.packDir!, ctx.cfg.method!.name);
    if (!route || !Object.hasOwn(this.method.routes, route))
      throw new TaskError(
        this.message('noRoute', `The task has no route of method ${this.method.name}`),
      );
    this.routeId = route;
    this.route = routeOf(this.method, route);
  }
  /** A method text (messages:), in the company's language. */
  message(key: string, fallback: string) {
    return this.method.messages[key] ?? fallback;
  }
  private get options() {
    return methodOptions(this.method, this.ctx.cfg);
  }
  /** {{vars.x}}, {{options.x}}, {{slug}}, {{route}}, {{git.name}}, {{git.email}} in method values. */
  interp(text: string) {
    return text.replace(
      /\{\{(vars|options)\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}|\{\{(slug|route|git\.name|git\.email)\}\}/g,
      (_, scope: string, key: string, plain: string) => {
        if (scope === 'vars') {
          const v = this.vars[key];
          return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
        }
        if (scope === 'options') return this.options[key] ?? '';
        if (plain === 'slug') return this.task.branch;
        if (plain === 'route') return this.routeId;
        if (plain === 'git.name') return this.ctx.tenant.git.authorName;
        return this.ctx.tenant.git.authorEmail;
      },
    );
  }
  /** The environment of the agent and hooks (variables that come out empty are not passed). */
  env() {
    return Object.fromEntries(
      Object.entries(this.method.env)
        .map(([k, v]) => [k, this.interp(v)] as const)
        .filter(([, v]) => v !== ''),
    );
  }
  /** prompts/x-{{route}}.md of the route, else prompts/x.md. */
  private file(path: string) {
    const own = join(this.method.dir, path.replace(/\{\{route\}\}/g, this.routeId));
    if (existsSync(own)) return own;
    const shared = join(this.method.dir, path.replace(/-\{\{route\}\}/g, ''));
    if (existsSync(shared)) return shared;
    throw new TaskError(
      `method ${this.method.name}: ${path} not found for route ${this.routeId}`,
      false,
    );
  }
  render(path: string, values: TemplateValues = {}, state?: MethodState) {
    return fillTemplate(readFileSync(this.file(path), 'utf8'), {
      MATERIAL: this.task.instructions,
      SLUG: this.task.branch,
      ROUTE: this.routeId,
      AUTHORIZATION: state?.authorization ?? '',
      NOTES: state?.notes ?? [],
      ANSWERS: state?.answers ?? [],
      // The agent's last report (its decisions), for the person to review at a gate.
      REPORT: typeof this.task.result?.message === 'string' ? this.task.result.message : '',
      ...this.route.vars,
      ...values,
    });
  }
  private async pending(path?: string) {
    return porcelainPaths(
      await this.deps.git.git(this.task, [
        'status',
        '--porcelain',
        '-z',
        '--untracked-files=all',
        ...(path ? ['--', path] : []),
      ]),
    );
  }
  /** Runs a hook of the method in the task folder; its last stdout line (JSON) adds variables. */
  async hook(path: string, first: boolean) {
    const ws = this.ctx.ws;
    if (!this.uploaded) {
      await ws.remove(HOOKS_DIR);
      await ws.upload(join(this.method.dir, 'hooks'), `${HOOKS_DIR}/hooks`);
      this.uploaded = true;
    }
    const target = `${HOOKS_DIR}/${path}`;
    const r = await ws.run([path.endsWith('.py') ? 'python3' : 'sh', target], {
      timeoutMs: 5 * 60000,
      taskId: this.task.id,
      agent: 'method-hook',
      env: { ...this.env(), ...GIT_SAFETY },
      input: JSON.stringify({
        first,
        taskId: this.task.id,
        project: this.ctx.cfg.id,
        slug: this.task.branch,
        route: this.routeId,
        root: ws.root,
        options: this.options,
        vars: this.vars,
      }),
    });
    if (!r.success)
      throw new TaskError(
        (r.stderr.trim() || r.stdout.trim() || `hook ${path} failed`).slice(-2000),
        false,
      );
    const last = r.stdout.trim().split('\n').pop() ?? '';
    try {
      const out = JSON.parse(last) as unknown;
      if (out && typeof out === 'object' && !Array.isArray(out)) Object.assign(this.vars, out);
    } catch {
      // A hook that prints no JSON adds no variables.
    }
  }
  /** Prepare hook (every run), then the route's own hooks. */
  async prepare(first: boolean) {
    if (this.method.hooks.prepare) await this.hook(this.method.hooks.prepare, first);
    for (const hook of this.route.before) await this.hook(hook, first);
  }
  /** Text appended to the core prompt on a standard-flow route. */
  append() {
    return this.route.append ? this.render(this.route.append) : '';
  }
  /** A finished rehearsal stays finished: a failed advance is only logged. */
  async finishRehearsal() {
    if (!this.method.hooks.advance) return;
    try {
      await this.hook(this.method.hooks.advance, false);
    } catch (error) {
      log('method.advance_failed', {
        taskId: this.task.id,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
  }
  /** The method's own flow: its phases, then the end rules; returns after commit (no push). */
  async run(base: string): Promise<void> {
    const { task, ctx, deps } = this;
    const state = (task.result ??= {});
    const ms = (state.method ??= methodState(state) ?? { phase: this.route.start! }) as MethodState;
    await deps.stage(task, 'WORKSPACE');
    const first = !state.baseSha;
    await deps.git.prepare(task, base, ctx.remote, {
      resetToBase: first,
      newBranch: true,
      hidden: ctx.cfg.hiddenFiles,
    });
    await this.prepare(first);
    if (first) {
      state.baseSha = await deps.git.git(task, ['rev-parse', 'HEAD']);
      await deps.stage(task, 'PREPARED');
    }
    const author = { name: ctx.tenant.git.authorName, email: ctx.tenant.git.authorEmail };
    const answer = async () => {
      const asked = ms.asked;
      ms.asked = undefined;
      if (!asked) return undefined;
      const decisions = await deps.db.getRepository(Decision).findBy({
        taskId: task.id,
        type: 'question',
        status: 'answered',
      });
      const last = decisions
        .filter((d) => d.questions?.[0]?.text === asked && d.answeredAt)
        .sort((a, b) => b.answeredAt!.getTime() - a.answeredAt!.getTime())[0];
      return (last?.answer as { answers?: string[] } | undefined)?.answers?.[0];
    };
    const ask = async (
      question: DecisionQuestion,
      by: NonNullable<MethodState['askedBy']>,
    ): Promise<never> => {
      ms.asked = question.text;
      ms.askedBy = by;
      await deps.db.getRepository(Task).save(task);
      throw new NeedsInput([question], true);
    };
    const nextOf = (n: string | Record<string, string>) =>
      typeof n === 'string' ? n : (n[this.routeId] ?? n.default ?? 'done');
    const agent = async (prompt: string) => {
      const out = await deps.router.run(
        ctx.tenant,
        'coder',
        {
          taskId: task.id,
          tenantId: task.tenantId,
          workspace: task.workspace,
          ...(ctx.ws.kind === 'coder' ? { remote: ctx.ws as CoderWorkspace } : {}),
          env: this.env(),
          addDirs: this.method.agent.addDirs,
          allowedTools: this.method.agent.allowedTools,
          timeoutMs: this.method.timeoutMinutes * 60000,
          prompt,
        },
        async () => {},
      );
      deps.record(task, out.attempts, out.credential.provider);
      if (!out.result.success)
        throw new TaskError(
          `${this.message('failed', 'Method failed: ')}${out.result.errorText ?? out.result.stderr}`,
        );
      if (out.result.message) state.message = auditable(out.result.message.slice(-20000));
      return readOutcome(out.result.message);
    };
    phases: while (ms.phase !== 'done') {
      const phase = this.method.phases[ms.phase];
      if (!phase) throw new TaskError(`method ${this.method.name}: no phase "${ms.phase}"`, false);
      // The operator's answer to the question this task left open, if any.
      const by = ms.askedBy;
      let reply = await answer();
      ms.askedBy = undefined;
      if (reply && by && by !== 'ask') {
        ms[by] = [...(ms[by] ?? []), reply];
        reply = undefined;
      }
      for (const step of phase.steps) {
        if ('require' in step) {
          if (!this.vars[step.require.var])
            throw new TaskError(this.message(step.require.message, step.require.message), false);
        } else if ('discard' in step) {
          const path = this.interp(step.discard);
          if ((await deps.git.git(task, ['ls-files', '--', path])).trim())
            await deps.git.git(task, ['checkout', 'HEAD', '--', path]);
          await deps.git.git(task, ['clean', '-fdq', '--', path]);
        } else if ('agent' in step) {
          await deps.stage(task, ms.phase.toUpperCase());
          const outcome = await agent(this.render(step.agent, {}, ms));
          if (!outcome.done)
            await ask(
              {
                text: this.render('prompts/stop-question.md', { PENDING: outcome.pending }, ms),
                options: outcome.options.length
                  ? outcome.options
                  : [this.render('prompts/stop-option.md', {}, ms).trim()],
              },
              step.answersTo,
            );
        } else if ('within' in step) {
          const path = this.interp(step.within.path);
          const outside = (await this.pending()).filter((f) => !under(f, path));
          if (outside.length)
            await ask(
              {
                text: this.render(step.within.question, { FILES: outside }, ms),
                options: [this.render(step.within.option, {}, ms).trim()],
              },
              'notes',
            );
        } else if ('ask' in step) {
          const option = this.render(step.ask.option, {}, ms).trim();
          if (reply !== undefined) {
            // The option itself, or a plain approval of it: what is quoted is the option's text.
            if (reply.trim() === option || isApproval(reply)) {
              ms.authorization = option;
              const commit = step.ask.chosen.commit;
              if (commit && (!commit.routes || commit.routes.includes(this.routeId))) {
                const paths = commit.paths.map((p) => this.interp(p));
                if ((await this.pendingUnder(paths)).length)
                  await deps.git.commitPaths(task, paths, this.interp(commit.message), author);
              }
              ms.phase = nextOf(step.ask.chosen.next);
              continue phases;
            }
            ms.notes = [...(ms.notes ?? []), reply.trim()];
            reply = undefined;
            const target = nextOf(step.ask.other.next);
            if (target !== ms.phase) {
              ms.phase = target;
              continue phases;
            }
          }
          await deps.stage(task, ms.phase.toUpperCase());
          const files =
            step.ask.files &&
            (!step.ask.files.routes || step.ask.files.routes.includes(this.routeId))
              ? await this.pending(this.interp(step.ask.files.path))
              : [];
          await ask(
            { text: this.render(step.ask.question, { FILES: files }, ms), options: [option] },
            'ask',
          );
        } else if ('hook' in step) {
          await this.hook(step.hook, false);
        }
      }
      ms.phase = phase.next === undefined ? 'done' : nextOf(phase.next);
      await deps.db.getRepository(Task).save(task);
    }
    // The project's own tests and checks, as for any delivery (no fixer: the method owns the code).
    if (this.route.tests) await deps.tests();
    if (this.route.finish) {
      // The person's words authorized this commit: exactly the files the route changed.
      const changed = await this.pending();
      if (!changed.length)
        throw new TaskError(this.message('finishNoChanges', 'NO_CHANGES: nothing changed'));
      await deps.git.commitPaths(task, changed, this.interp(this.route.finish.commit), author);
    }
    // The method commits its own work; anything left is its stop, never ours to sweep.
    if (this.method.commits === 'method') {
      const left = await this.pending();
      if (left.length)
        throw new TaskError(
          `${this.message('leftovers', 'The method left changes outside its commits:')}\n${left
            .slice(0, 20)
            .map((f) => `- ${f}`)
            .join('\n')}`,
          false,
        );
    }
    const files = await deps.git.changedSince(task, String(state.baseSha));
    if (!files.length) throw new TaskError(this.message('noChanges', 'NO_CHANGES: no changes'));
    state.changes = { files };
    state.commitSha = await deps.git.git(task, ['rev-parse', 'HEAD']);
    await deps.stage(task, 'COMMITTED');
    if (this.route.evidence) await deps.evidence(this.routeId);
  }
  private async pendingUnder(paths: string[]) {
    const all = await this.pending();
    return all.filter((f) => paths.some((p) => under(f, p)));
  }
}
