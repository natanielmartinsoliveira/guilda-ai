import { t, type Key } from './i18n';
import type { ChangeEvent, TaskView } from './types';
export type Filter = 'all' | 'active' | 'waiting' | 'pr' | 'failed' | 'cancelled';
/** Filter and the key of its label (t(label) where shown). */
export const FILTERS: [Filter, Key][] = [
  ['all', 'filter.all'],
  ['active', 'status.running'],
  ['waiting', 'status.waiting'],
  ['pr', 'status.pr'],
  ['failed', 'status.failed'],
  ['cancelled', 'status.cancelled'],
];
const running = (status: string) => status === 'PENDING' || status === 'RUNNING';
/** `waiting`: ids of tasks with an open decision. */
export function matches(task: TaskView, filter: Filter, waiting: Set<string>) {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return running(task.status) || task.revisions.some((r) => running(r.status));
    case 'waiting':
      return (
        waiting.has(task.id) ||
        task.status === 'WAITING' ||
        task.revisions.some((r) => r.status === 'WAITING')
      );
    case 'pr':
      return task.status === 'SUCCESS' && !!task.prUrl;
    case 'failed':
      return task.status === 'FAILED' || task.revisions.some((r) => r.status === 'FAILED');
    case 'cancelled':
      return task.status === 'CANCELLED';
  }
}
export function statusLabel(task: TaskView, waiting: Set<string>) {
  if (waiting.has(task.id) || task.status === 'WAITING') return t('status.waiting');
  switch (task.status) {
    case 'PENDING':
      return t('status.queued');
    case 'RUNNING':
      return t('status.running');
    case 'SUCCESS':
      return task.prUrl ? t('status.pr') : t('status.done');
    case 'FAILED':
      return t('status.failed');
    case 'CANCELLED':
      return t('status.cancelled');
    default:
      return task.status;
  }
}
/** Stages the panel knows how to name (any other is shown as it comes). */
const STAGES = new Set([
  'QUEUED',
  'WORKSPACE',
  'PREPARED',
  'DEPENDENCIES',
  'PLANNING',
  'PLANNED',
  'DESIGN',
  'FRONTEND',
  'AGENT',
  'DIFF',
  'TESTS',
  'FIXING',
  'CHECKS',
  'FIXING_CHECKS',
  'REVIEW',
  'REVIEW_FIX',
  'COMMIT',
  'COMMITTED',
  'PUSH',
  'PULL_REQUEST',
  'DONE',
  'SPEC',
  'GATE',
  'DELIVER',
  'EVIDENCE',
  'REHEARSED',
  'WAITING_INPUT',
  'WAITING_CAPACITY',
]);
export function stageLabel(stage: string) {
  return STAGES.has(stage) ? t(`stage.${stage}` as Key) : stage;
}
export const PHASES = [
  {
    id: 'queue',
    get label() {
      return t('phase.queue');
    },
    stages: ['QUEUED'],
  },
  {
    id: 'prepare',
    get label() {
      return t('phase.prepare');
    },
    stages: ['WORKSPACE', 'PREPARED', 'DEPENDENCIES', 'DESIGN'],
  },
  {
    id: 'plan',
    get label() {
      return t('phase.plan');
    },
    stages: ['PLANNING', 'PLANNED', 'SPEC', 'GATE'],
  },
  {
    id: 'code',
    get label() {
      return t('phase.code');
    },
    stages: ['AGENT', 'DIFF', 'FRONTEND', 'DELIVER'],
  },
  {
    id: 'tests',
    get label() {
      return t('phase.tests');
    },
    stages: ['TESTS', 'FIXING'],
  },
  {
    id: 'checks',
    get label() {
      return t('phase.checks');
    },
    stages: ['CHECKS', 'FIXING_CHECKS'],
  },
  {
    id: 'review',
    get label() {
      return t('phase.review');
    },
    stages: ['REVIEW', 'REVIEW_FIX'],
  },
  {
    id: 'deliver',
    get label() {
      return t('phase.deliver');
    },
    stages: ['COMMIT', 'COMMITTED', 'PUSH', 'PULL_REQUEST'],
  },
];
/** Position in the timeline: -1 while waiting (operator or quota), PHASES.length when done. */
export function phaseIndex(stage: string) {
  if (stage === 'DONE' || stage === 'REHEARSED') return PHASES.length;
  if (stage === 'WAITING_INPUT' || stage === 'WAITING_CAPACITY') return -1;
  const index = PHASES.findIndex((p) => p.stages.includes(stage));
  return index === -1 ? 0 : index;
}
export function ago(iso: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return t('ago.now');
  if (seconds < 3600) return t('ago.minutes', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('ago.hours', { n: Math.floor(seconds / 3600) });
  return t('ago.days', { n: Math.floor(seconds / 86400) });
}
export function sortTasks(list: TaskView[]) {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function replaceTenants<T extends { tenantId: string }>(
  current: T[],
  ids: string[],
  fresh: T[],
) {
  return [...current.filter((item) => !ids.includes(item.tenantId)), ...fresh];
}
export function eventTenant(event: ChangeEvent, tasks: TaskView[]) {
  return event.tenantId ?? tasks.find((t) => t.id === event.taskId)?.tenantId;
}
/**
 * " pf 12 " and "pf - 12" become PF-12. A key typed without any separator is left as is: "AB234"
 * could be AB-234 or AB2-34, and starting the wrong card is worse than asking for the dash.
 */
export function normalizeKey(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*|\s+/g, '-');
}
/** A card key as its source writes it (Jira PF-123, or a number), or undefined. */
export function normalizeCardKey(format: 'jira' | 'number', raw: string): string | undefined {
  if (format === 'number') {
    const digits = raw.trim().replace(/^#/, '').replace(/\s+/g, '');
    return /^\d{1,12}$/.test(digits) ? digits : undefined;
  }
  const key = normalizeKey(raw);
  return validKey(key) ? key : undefined;
}
export function validKey(key: string) {
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(key);
}
