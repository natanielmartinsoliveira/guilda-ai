import type { RunUsage } from '../agents/agent.types';
import { addUsage } from '../agents/agent-router.service';
import { ROLES } from '../tenants/tenants';
interface TimedRun {
  agent: string;
  phase: string | null;
  usage: RunUsage | null;
  startedAt: Date;
  finishedAt: Date | null;
}
interface TimedDecision {
  type: string;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
  updatedAt: Date;
}
export interface PhaseMetrics {
  runs: number;
  agentMs: number;
  usage?: RunUsage;
  /** What its runs cost, as the providers reported it per model (USD). */
  costUsd?: number;
}
export interface TaskMetrics {
  totalMs: number;
  /** The AI agents' own runs (checks, git and the workspace's probes are not counted). */
  agentMs: number;
  /** Open questions and failures waiting for the person. */
  waitingMs: number;
  /** Whatever is neither: queue, retry delays, tests, checks, git, the workspace. */
  otherMs: number;
  waits: { questions: number; failures: number };
  /** Agent runs per step: the method phase, else the agent's role (coder, fixer, reviewer…). */
  phases: Record<string, PhaseMetrics>;
}
const AI_AGENTS = new Set<string>(ROLES);
const span = (from: Date, to: Date) => Math.max(0, to.getTime() - from.getTime());
/** Where a task's wall-clock went, from its runs and decisions. */
export function taskMetrics(
  task: { status: string; createdAt: Date; updatedAt: Date },
  runs: TimedRun[],
  decisions: TimedDecision[],
  now = new Date(),
): TaskMetrics {
  const live = ['PENDING', 'RUNNING', 'WAITING'].includes(task.status);
  const totalMs = span(task.createdAt, live ? now : task.updatedAt);
  const phases: Record<string, PhaseMetrics> = {};
  let agentMs = 0;
  for (const run of runs.filter((r) => AI_AGENTS.has(r.agent))) {
    const ms = span(run.startedAt, run.finishedAt ?? now);
    agentMs += ms;
    const phase = (phases[run.phase ?? run.agent] ??= { runs: 0, agentMs: 0 });
    phase.runs++;
    phase.agentMs += ms;
    if (run.usage) {
      phase.usage = addUsage(phase.usage, run.usage);
      const cost = Object.values(run.usage.byModel ?? {}).reduce((s, m) => s + (m.costUsd ?? 0), 0);
      if (cost) phase.costUsd = (phase.costUsd ?? 0) + cost;
    }
  }
  const waitingMs = decisions.reduce(
    (total, d) =>
      total + span(d.createdAt, d.answeredAt ?? (d.status === 'open' ? now : d.updatedAt)),
    0,
  );
  return {
    totalMs,
    agentMs,
    waitingMs,
    otherMs: Math.max(0, totalMs - agentMs - waitingMs),
    waits: {
      questions: decisions.filter((d) => d.type === 'question').length,
      failures: decisions.filter((d) => d.type === 'failure').length,
    },
    phases,
  };
}
