import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config, log, redact, TaskError } from '../config';
import { AgentRun, CredentialState, Decision, Task } from '../database/entities';
import { t } from '../i18n';
import { isApproval } from '../methods/approval';
import { NeedsInput } from '../tasks/decisions';
import { AiCredential, AiEffort, AiRole, Tenant } from '../tenants/tenants';
import { AgentService } from './agent.service';
import { AgentInput, AgentResult, RunUsage } from './agent.types';
import { classifyFailure, FailureKind, retryAfterMinutes } from './failure';
export interface AgentAttempt {
  credential: string;
  provider: string;
  role?: AiRole;
  model?: string;
  effort?: AiEffort;
  outcome: 'success' | FailureKind;
  error?: string;
  /** The models the run really used, as the provider reported them. */
  usedModels?: string[];
  /** What the run cost (USD), as the provider reported it. */
  costUsd?: number;
  /** Tokens, turns and time, as the provider reported them. */
  usage?: RunUsage;
}
const BUDGET_MARK = '💰';
const plus = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
/** A task's running total: tokens, turns and time summed, per model too. */
export function addUsage(total: RunUsage | null | undefined, run: RunUsage): RunUsage {
  const t = total ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const byModel = { ...t.byModel };
  for (const [model, u] of Object.entries(run.byModel ?? {})) {
    const m = byModel[model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    const costUsd = plus(m.costUsd, u.costUsd);
    byModel[model] = {
      input: m.input + u.input,
      output: m.output + u.output,
      cacheCreation: m.cacheCreation + u.cacheCreation,
      cacheRead: m.cacheRead + u.cacheRead,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
  const sum: RunUsage = {
    input: t.input + run.input,
    output: t.output + run.output,
    cacheCreation: t.cacheCreation + run.cacheCreation,
    cacheRead: t.cacheRead + run.cacheRead,
  };
  const durationMs = plus(t.durationMs, run.durationMs);
  const apiDurationMs = plus(t.apiDurationMs, run.apiDurationMs);
  const turns = plus(t.turns, run.turns);
  return {
    ...sum,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(apiDurationMs !== undefined ? { apiDurationMs } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(Object.keys(byModel).length ? { byModel } : {}),
  };
}
const usd = (n: number) => n.toFixed(2);
/** Every credential is out of capacity: the task should wait, not fail. */
export class CapacityError extends TaskError {
  constructor(
    message: string,
    public readonly until: Date,
    public readonly attempts: AgentAttempt[],
  ) {
    super(message, false);
  }
}
/** Credentials in configured order, with the time each one becomes usable again. */
export async function credentialStatus(db: DataSource, tenant: Tenant) {
  const states = await db.getRepository(CredentialState).findBy({ tenantId: tenant.id });
  const byId = new Map(states.map((s) => [s.credentialId, s]));
  const now = Date.now();
  return tenant.ai.credentials.map((credential) => {
    const state = byId.get(credential.id);
    const blocked = !!state && state.unavailableUntil.getTime() > now;
    return {
      credential,
      // Defense in depth: schema validation already ties credentials to allowed providers.
      available: !blocked && tenant.ai.providers.includes(credential.provider),
      unavailableUntil: blocked ? state.unavailableUntil : undefined,
      reason: blocked ? state.reason : undefined,
      lastError: blocked ? state.lastError : undefined,
    };
  });
}
export type RouterInput = Omit<
  AgentInput,
  'credentialId' | 'apiKey' | 'model' | 'effort' | 'timeoutMs' | 'role'
> & {
  /** Overrides the provider's default (e.g. a method route carrying a whole scope). */
  timeoutMs?: number;
  /** The method phase this run belongs to, kept on its agent_runs row. */
  phase?: string;
};
export interface RoleTarget {
  credential: AiCredential;
  model?: string;
  effort?: AiEffort;
}
/**
 * Credentials (with model and effort) for a role, in order. coder: every credential unless
 * configured; fixer: coder unless configured; reviewer and planner: only when configured
 * (empty list = role disabled), so they never silently land on a weak or costly default.
 */
export function roleTargets(tenant: Tenant, role: AiRole): RoleTarget[] {
  const configured =
    tenant.ai.roles[role] ?? (role === 'fixer' ? tenant.ai.roles.coder : undefined);
  if (!configured)
    return role === 'coder' || role === 'fixer'
      ? tenant.ai.credentials.map((credential) => ({
          credential,
          model: credential.model,
          effort: credential.effort,
        }))
      : [];
  return configured.map((e) => {
    // Schema validation guarantees the credential exists.
    const credential = tenant.ai.credentials.find((c) => c.id === e.credential)!;
    return {
      credential,
      model: e.model ?? credential.model,
      effort: e.effort ?? credential.effort,
    };
  });
}
@Injectable()
export class AgentRouter {
  constructor(
    private readonly db: DataSource,
    private readonly agents: AgentService,
  ) {}
  status(tenant: Tenant) {
    return credentialStatus(this.db, tenant);
  }
  /**
   * A task at its budget does not start another run: it asks to release one more share. Each
   * answered budget question that approved (its option, or a plain approval) adds one share.
   */
  /**
   * Adds a run's cost and usage to its task (one run per task at a time: no race), and keeps
   * the usage and phase on the run's own row.
   */
  private async account(taskId: string, result: AgentResult, phase?: string) {
    if (result.runId && (result.usage || phase))
      await this.db
        .getRepository(AgentRun)
        .update(result.runId, { usage: result.usage ?? null, phase: phase ?? null });
    if (!result.costUsd && !result.usage) return;
    const tasks = this.db.getRepository(Task);
    const task = await tasks.findOneBy({ id: taskId });
    if (!task) return;
    await tasks.update(taskId, {
      costUsd: Number(task.costUsd ?? 0) + (result.costUsd ?? 0),
      ...(result.usage ? { usage: addUsage(task.usage, result.usage) } : {}),
    });
  }
  private async checkBudget(tenant: Tenant, taskId: string) {
    const share = tenant.ai.budget?.perTaskUsd;
    if (!share) return;
    const task = await this.db.getRepository(Task).findOneBy({ id: taskId });
    if (!task) return;
    const option = t('budget.release', { usd: usd(share) });
    const answered = await this.db
      .getRepository(Decision)
      .findBy({ taskId, type: 'question', status: 'answered' });
    const released = answered.filter((d) => {
      if (!d.questions?.[0]?.text.startsWith(BUDGET_MARK)) return false;
      const reply = (d.answer as { answers?: string[] } | null)?.answers?.[0] ?? '';
      return reply.trim() === option || isApproval(reply);
    }).length;
    const limit = share * (1 + released);
    const spent = Number(task.costUsd ?? 0);
    if (spent < limit) return;
    throw new NeedsInput(
      [
        {
          text: `${BUDGET_MARK} ${t('budget.reached', { spent: usd(spent), limit: usd(limit), usd: usd(share) })}`,
          options: [option],
        },
      ],
      true,
    );
  }
  /**
   * Runs the agent with the role's first usable credential; on quota, rate-limit or auth
   * failures parks that credential (for every role) and continues with the next. Task failures
   * stop immediately: retrying a broken task with every key would only multiply cost.
   */
  async run(
    tenant: Tenant,
    role: AiRole,
    input: RouterInput,
    beforeFallback: () => Promise<void>,
  ): Promise<{ result: AgentResult; credential: AiCredential; attempts: AgentAttempt[] }> {
    const targets = roleTargets(tenant, role);
    if (!targets.length) throw new TaskError(`AI role "${role}" has no credentials`);
    await this.checkBudget(tenant, input.taskId);
    const available = new Set(
      (await this.status(tenant)).filter((s) => s.available).map((s) => s.credential.id),
    );
    const usable = targets.filter((t) => available.has(t.credential.id));
    const attempts: AgentAttempt[] = [];
    for (const [index, { credential, model, effort }] of usable.entries()) {
      if (index > 0) await beforeFallback();
      const result = await this.agents.execute(credential.provider, {
        ...input,
        role,
        credentialId: credential.id,
        apiKey: credential.apiKey,
        model,
        effort,
        timeoutMs:
          input.timeoutMs ??
          (credential.provider === 'claude'
            ? config().CLAUDE_TIMEOUT_MS
            : config().CODEX_TIMEOUT_MS),
      });
      const outcome = result.success ? 'success' : classifyFailure(result);
      const attempt: AgentAttempt = {
        credential: credential.id,
        provider: credential.provider,
        role,
        model,
        effort,
        outcome,
        ...(result.models?.length ? { usedModels: result.models } : {}),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
      attempts.push(attempt);
      await this.account(input.taskId, result, input.phase);
      if (outcome === 'success' || outcome === 'task') return { result, credential, attempts };
      attempt.error = redact(result.errorText ?? result.stderr).slice(-500);
      await this.park(tenant, credential, outcome, result);
    }
    const roleIds = new Set(targets.map((t) => t.credential.id));
    const next = (await this.status(tenant))
      .filter((s) => roleIds.has(s.credential.id))
      .map((s) => s.unavailableUntil)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    // Only possible without any parked credential if the provider allowlist excludes them all.
    if (!next) throw new TaskError('No AI credential allowed for this tenant');
    throw new CapacityError(
      `All AI credentials unavailable until ${next.toISOString()} (${attempts.map((a) => `${a.credential}: ${a.outcome}`).join(', ') || 'all parked'})`,
      next,
      attempts,
    );
  }
  private async park(
    tenant: Tenant,
    credential: AiCredential,
    reason: Exclude<FailureKind, 'task'>,
    result: AgentResult,
  ) {
    const cooldown = {
      quota: credential.cooldown.quotaMinutes,
      rate_limit: credential.cooldown.rateLimitMinutes,
      auth: credential.cooldown.authMinutes,
    }[reason];
    // A limit the provider states ("try again in 3 hours") beats the configured default.
    const minutes = reason === 'auth' ? cooldown : (retryAfterMinutes(result) ?? cooldown);
    const unavailableUntil = new Date(Date.now() + minutes * 60000);
    await this.db.getRepository(CredentialState).save({
      tenantId: tenant.id,
      credentialId: credential.id,
      unavailableUntil,
      reason,
      lastError: redact(result.errorText ?? result.stderr).slice(-2000),
    });
    log('agent.credential_parked', {
      tenant: tenant.id,
      credential: credential.id,
      provider: credential.provider,
      reason,
      until: unavailableUntil.toISOString(),
    });
  }
}
