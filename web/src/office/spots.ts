import { t, type Key } from '../i18n';
import type { AgentAttempt, DecisionView, TaskView } from '../types';
export const TILE = 16;
export const MAP_W = 24;
export const MAP_H = 15;
/** Font sizes in room pixels (a tile is 16): spots.ts spaces things so they stay readable. */
export const LABEL_FONT = 6;
export const KEY_FONT = 5;
/** Tiny Dungeon frame used for a task's folder (a parchment). */
export const FOLDER_FRAME = 66;
export type SpotId =
  | 'queue'
  | 'architect'
  | 'coder'
  | 'tester'
  | 'fixer'
  | 'guard'
  | 'reviewer'
  | 'delivery'
  | 'waiting'
  | 'pantry'
  | 'mural';
/** A frame of a sprite sheet at a tile position (fractions allowed). */
export interface Sprite {
  sheet: 'dungeon' | 'town';
  frame: number;
  x: number;
  y: number;
}
export interface Spot {
  id: SpotId;
  label: string;
  labelAt: { x: number; y: number };
  /** Where the first folder sits; the others follow to the right, one row. */
  x: number;
  y: number;
  /** Folders drawn here; the rest are counted next to the label ("+N"). */
  max: number;
  character?: Sprite;
  prop?: Sprite;
}
/** Distance between folders: a card key (e.g. PF-24276) is about 1.6 tiles wide. */
export const FOLDER_GAP = 1.65;
const desk = (
  id: SpotId,
  labelKey: Key,
  x: number,
  y: number,
  character: number,
  prop = 72,
): Spot => ({
  id,
  get label() {
    return t(labelKey);
  },
  labelAt: { x, y: y + 0.8 },
  x: x - FOLDER_GAP,
  y: y + 1.9,
  max: 3,
  character: { sheet: 'dungeon', frame: character, x, y: y - 1 },
  prop: { sheet: 'dungeon', frame: prop, x, y },
});
/**
 * The room (24 × 15 tiles): two rows of desks, the counter and the pantry, the queue by the
 * entrance (bottom left), delivery by the side door, and the mural under the top wall.
 */
export const SPOTS: Record<SpotId, Spot> = {
  architect: desk('architect', 'role.planner', 3, 4, 84),
  coder: desk('coder', 'role.coder', 8, 4, 85),
  tester: desk('tester', 'guild.tester', 13, 4, 86),
  fixer: desk('fixer', 'role.fixer', 18, 4, 88, 74),
  guard: desk('guard', 'phase.checks', 3, 8.5, 96),
  reviewer: desk('reviewer', 'role.reviewer', 8, 8.5, 99),
  waiting: {
    id: 'waiting',
    get label() {
      return t('guild.waitingSpot');
    },
    labelAt: { x: 13, y: 9.3 },
    x: 13 - FOLDER_GAP,
    y: 10.4,
    max: 3,
    prop: { sheet: 'town', frame: 83, x: 13, y: 8.5 },
  },
  pantry: {
    id: 'pantry',
    get label() {
      return t('guild.pantry');
    },
    labelAt: { x: 18, y: 9.3 },
    x: 18 - FOLDER_GAP,
    y: 10.4,
    max: 3,
    prop: { sheet: 'dungeon', frame: 82, x: 18, y: 8.5 },
  },
  delivery: {
    id: 'delivery',
    get label() {
      return t('phase.deliver');
    },
    labelAt: { x: 21, y: 13 },
    x: 15.5,
    y: 12.6,
    max: 3,
    character: { sheet: 'dungeon', frame: 112, x: 21, y: 11.3 },
    prop: { sheet: 'dungeon', frame: 89, x: 21, y: 12.3 },
  },
  queue: {
    id: 'queue',
    get label() {
      return t('phase.queue');
    },
    labelAt: { x: 2, y: 12.4 },
    x: 3.85,
    y: 12.6,
    max: 6,
  },
  mural: {
    id: 'mural',
    get label() {
      return t('guild.mural');
    },
    labelAt: { x: 3, y: 1 },
    x: 5.65,
    y: 1.6,
    max: 8,
    prop: { sheet: 'dungeon', frame: 41, x: 3, y: 0 },
  },
};
const STAGE_SPOTS: Record<string, SpotId> = {
  QUEUED: 'queue',
  WORKSPACE: 'tester',
  PREPARED: 'tester',
  DEPENDENCIES: 'tester',
  TESTS: 'tester',
  PLANNING: 'architect',
  PLANNED: 'architect',
  AGENT: 'coder',
  DIFF: 'coder',
  REVIEW_FIX: 'coder',
  FIXING: 'fixer',
  FIXING_CHECKS: 'fixer',
  CHECKS: 'guard',
  REVIEW: 'reviewer',
  COMMIT: 'delivery',
  COMMITTED: 'delivery',
  PUSH: 'delivery',
  PULL_REQUEST: 'delivery',
  WAITING_INPUT: 'waiting',
  WAITING_CAPACITY: 'pantry',
};
/** Where a job is in the office, or null when it has left (cancelled, decided failure, no PR). */
export function stageToSpot(
  job: { status: string; stage: string; prUrl?: string },
  openDecision: boolean,
): SpotId | null {
  if (openDecision || job.status === 'WAITING') return 'waiting';
  if (job.status === 'CANCELLED' || job.status === 'FAILED') return null;
  if (job.status === 'SUCCESS' || job.stage === 'DONE') return job.prUrl ? 'mural' : null;
  return STAGE_SPOTS[job.stage] ?? 'queue';
}
export interface Folder {
  taskId: string;
  key: string;
  spot: SpotId;
  x: number;
  y: number;
}
export interface Desk {
  spot: SpotId;
  busy: boolean;
  taskId?: string;
  key?: string;
  ai?: string;
}
export interface OfficeModel {
  roomKey?: string;
  loaded?: boolean;
  guild?: GuildState;
  crew: CrewMember[];
  seats?: number;
  folders: Folder[];
  desks: Desk[];
  /** Tasks beyond a spot's `max`, shown as "+N" next to its label. */
  extra: Partial<Record<SpotId, number>>;
}
/** Revisions run one at a time: the one working wins over a failed or a queued one. */
const PRIORITY: Record<string, number> = { RUNNING: 0, WAITING: 1, FAILED: 2, PENDING: 3 };
/** The job the office shows: a live revision (or failed) wins over its finished task. */
export function currentJob(task: TaskView) {
  const revision = task.revisions
    .filter((r) => r.status in PRIORITY)
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || a.number - b.number)[0];
  if (revision)
    return {
      revisionNumber: revision.number,
      status: revision.status,
      stage: revision.stage,
      prUrl: task.prUrl,
      attempts: revision.agentAttempts,
    };
  return {
    revisionNumber: undefined,
    status: task.status,
    stage: task.stage,
    prUrl: task.prUrl,
    attempts: task.agentAttempts,
  };
}
function aiOf(attempts?: AgentAttempt[]) {
  const last = attempts?.[attempts.length - 1];
  if (!last) return undefined;
  return last.model ? `${last.credential} · ${last.model}` : last.credential;
}
export function officeModel(tasks: TaskView[], decisions: DecisionView[]): OfficeModel {
  const waiting = new Set(decisions.filter((d) => d.status === 'open').map((d) => d.taskId));
  const placed = tasks
    .map((task) => {
      const job = currentJob(task);
      return { task, job, spot: stageToSpot(job, waiting.has(task.id)) };
    })
    .filter((p): p is typeof p & { spot: SpotId } => p.spot !== null);
  const folders: Folder[] = [];
  const extra: OfficeModel['extra'] = {};
  for (const spot of Object.values(SPOTS)) {
    const here = placed.filter((p) => p.spot === spot.id);
    // The mural shows the newest PRs; elsewhere, those working first, then by arrival, so a
    // folder keeps its place while its task changes.
    const ordered =
      spot.id === 'mural'
        ? here.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
        : here.sort(
            (a, b) =>
              Number(b.job.status === 'RUNNING') - Number(a.job.status === 'RUNNING') ||
              a.task.createdAt.localeCompare(b.task.createdAt),
          );
    ordered.slice(0, spot.max).forEach(({ task }, slot) =>
      folders.push({
        taskId: task.id,
        key: task.key ?? task.id.slice(0, 6),
        spot: spot.id,
        x: spot.x + slot * FOLDER_GAP,
        y: spot.y,
      }),
    );
    // Older PRs simply leave the mural; anywhere else, nobody is forgotten.
    if (spot.id !== 'mural' && ordered.length > spot.max)
      extra[spot.id] = ordered.length - spot.max;
  }
  const desks = Object.values(SPOTS)
    .filter((spot) => spot.character)
    .map((spot): Desk => {
      const working = placed
        .filter((p) => p.spot === spot.id && p.job.status === 'RUNNING')
        .sort((a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt))
        .pop();
      if (!working) return { spot: spot.id, busy: false };
      return {
        spot: spot.id,
        busy: true,
        taskId: working.task.id,
        key: working.task.key,
        ai: aiOf(working.job.attempts),
      };
    });
  return {
    folders,
    desks,
    extra,
    guild: guildState(tasks, decisions),
    crew: crew(tasks, decisions),
  };
}
const WALL = 40;
const FLOOR = [48, 49];
const DOOR = 46;
/** The room: stone walls around a sand floor, the entrance (bottom left) and the delivery door. */
export function floorPlan(): Sprite[] {
  const tiles: Sprite[] = [];
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) {
      const edge = x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
      const door = (x === 2 && y === MAP_H - 1) || (x === MAP_W - 1 && y === 12);
      const frame = door ? DOOR : edge ? WALL : FLOOR[(x * 7 + y * 3) % 5 === 0 ? 1 : 0];
      tiles.push({ sheet: 'dungeon', frame, x, y });
    }
  return tiles;
}
const DEMO_STAGES = [
  'QUEUED',
  'PLANNING',
  'AGENT',
  'TESTS',
  'FIXING',
  'CHECKS',
  'REVIEW',
  'PULL_REQUEST',
  'DONE',
];
/** Five fake tasks walking the pipeline, to see the office move without spending AI. */
export function demoModel(step: number): OfficeModel {
  const tasks = [0, 0, 2, 4, 6].map((offset, i): TaskView => {
    const stage = DEMO_STAGES[(step + offset) % DEMO_STAGES.length];
    return {
      id: `demo-${i + 1}`,
      tenantId: 'demo',
      branch: '',
      key: `DEMO-${i + 1}`,
      title: t('guild.demo'),
      status:
        i === 4 && stage === 'CHECKS'
          ? 'WAITING'
          : stage === 'DONE'
            ? 'SUCCESS'
            : stage === 'QUEUED'
              ? 'PENDING'
              : 'RUNNING',
      stage,
      prUrl: stage === 'DONE' ? 'https://example.invalid/pr' : undefined,
      provider: 'claude',
      attempts: 1,
      error: null,
      agentAttempts: [
        { credential: 'demo', provider: 'claude', model: 'opus', outcome: 'success' },
      ],
      revisions: [],
      attachments: [],
      decisions: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: `2026-01-01T00:00:0${i}Z`,
    };
  });
  return { ...officeModel(tasks, []), seats: 2 };
}

export const ROLES = ['architect', 'coder', 'tester', 'fixer', 'guard', 'reviewer'] as const;
export type GuildRole = (typeof ROLES)[number];
export const ROLE_STATUS: Record<GuildRole, string> = {
  get architect() {
    return t('guild.status.architect');
  },
  get coder() {
    return t('guild.status.coder');
  },
  get tester() {
    return t('guild.status.tester');
  },
  get fixer() {
    return t('guild.status.fixer');
  },
  get guard() {
    return t('guild.status.guard');
  },
  get reviewer() {
    return t('guild.status.reviewer');
  },
};
export interface GuildAgent {
  role: GuildRole;
  name: string;
  status: string;
  tone: 'working' | 'waiting' | 'error' | 'idle';
  tasks: TaskView[];
  task?: TaskView;
}
export interface GuildState {
  agents: GuildAgent[];
  active: number;
  completed: string[];
  waiting: number;
  queued: number;
}
const ATTEMPT_ROLE: Record<string, GuildRole> = {
  planner: 'architect',
  architect: 'architect',
  coder: 'coder',
  tester: 'tester',
  fixer: 'fixer',
  guard: 'guard',
  reviewer: 'reviewer',
};
export interface CrewMember {
  id: string;
  taskId: string;
  key: string;
  role: GuildRole;
  tone: 'working' | 'waiting' | 'error';
  ai?: string;
  createdAt?: string;
}
function jobEntries(tasks: TaskView[], decisions: DecisionView[]) {
  const waiting = new Set(decisions.filter((d) => d.status === 'open').map((d) => d.taskId));
  return tasks.map((task) => {
    const job = currentJob(task);
    const last = job.attempts?.at(-1);
    const stageRole = STAGE_SPOTS[job.stage];
    const role = ROLES.includes(stageRole as GuildRole)
      ? (stageRole as GuildRole)
      : last?.role
        ? ATTEMPT_ROLE[last.role]
        : undefined;
    return {
      task,
      job,
      role,
      blocked: waiting.has(task.id) || job.status === 'WAITING' || job.stage === 'WAITING_CAPACITY',
    };
  });
}
function entryTone(entry: ReturnType<typeof jobEntries>[number]): CrewMember['tone'] {
  return entry.job.status === 'FAILED'
    ? 'error'
    : entry.blocked || entry.job.status === 'PENDING'
      ? 'waiting'
      : 'working';
}
export function crew(tasks: TaskView[], decisions: DecisionView[]): CrewMember[] {
  return jobEntries(tasks, decisions)
    .filter(
      (e) =>
        e.role &&
        e.job.stage !== 'QUEUED' &&
        ['RUNNING', 'WAITING', 'FAILED', 'PENDING'].includes(e.job.status),
    )
    .map((e) => ({
      id: e.job.revisionNumber === undefined ? e.task.id : `${e.task.id}#${e.job.revisionNumber}`,
      taskId: e.task.id,
      key: e.task.key ?? e.task.id.slice(0, 6),
      role: e.role!,
      tone: entryTone(e),
      ai: aiOf(e.job.attempts),
      createdAt: e.task.createdAt,
    }));
}
/** The summary and visible crew share role and blocking rules. */
export function guildState(tasks: TaskView[], decisions: DecisionView[]): GuildState {
  const entries = jobEntries(tasks, decisions);
  const agents = ROLES.map((role): GuildAgent => {
    const here = entries
      .filter(
        (e) =>
          e.role === role && ['RUNNING', 'WAITING', 'FAILED', 'PENDING'].includes(e.job.status),
      )
      .sort(
        (a, b) =>
          (a.blocked ? 1 : a.job.status === 'RUNNING' ? 0 : 2) -
            (b.blocked ? 1 : b.job.status === 'RUNNING' ? 0 : 2) ||
          b.task.updatedAt.localeCompare(a.task.updatedAt),
      );
    const first = here[0];
    const tone = first ? entryTone(first) : 'idle';
    return {
      role,
      name: first ? (aiOf(first.job.attempts) ?? SPOTS[role].label) : SPOTS[role].label,
      status:
        tone === 'working'
          ? ROLE_STATUS[role]
          : tone === 'error'
            ? t('guild.error')
            : tone === 'waiting'
              ? t('guild.waiting')
              : t('guild.free'),
      tone,
      tasks: here.map((e) => e.task),
      task: first?.task,
    };
  });
  return {
    agents,
    active: entries.filter((e) => e.job.status === 'RUNNING' && !e.blocked && e.role).length,
    completed: tasks.filter((t) => t.status === 'SUCCESS').map((t) => t.id),
    waiting: decisions.filter((d) => d.status === 'open').length,
    queued: entries.filter((e) => e.job.status === 'PENDING').length,
  };
}
