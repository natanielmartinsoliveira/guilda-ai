import { describe, expect, test } from 'vitest';
import type { DecisionView, RevisionView, TaskView } from '../types';
import {
  demoModel,
  floorPlan,
  MAP_H,
  MAP_W,
  officeModel,
  KEY_FONT,
  LABEL_FONT,
  SpotId,
  SPOTS,
  stageToSpot,
} from './spots';
const job = (stage: string, status = 'RUNNING', prUrl?: string) => ({ stage, status, prUrl });
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  tenantId: 'acme',
  branch: 'ai/x',
  key: 'PF-1',
  title: 'x',
  status: 'RUNNING',
  stage: 'AGENT',
  provider: 'claude',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: '2026-10-06T10:00:00Z',
  updatedAt: '2026-10-06T10:00:00Z',
  ...over,
});
const inside = (p: { x: number; y: number }) =>
  p.x >= 0 && p.x <= MAP_W - 1 && p.y >= 0 && p.y <= MAP_H - 1;
describe('stageToSpot (spec 8.4 table)', () => {
  test.each([
    ['QUEUED', 'queue'],
    ['WORKSPACE', 'tester'],
    ['PREPARED', 'tester'],
    ['DEPENDENCIES', 'tester'],
    ['TESTS', 'tester'],
    ['PLANNING', 'architect'],
    ['PLANNED', 'architect'],
    ['AGENT', 'coder'],
    ['DIFF', 'coder'],
    ['REVIEW_FIX', 'coder'],
    ['FIXING', 'fixer'],
    ['FIXING_CHECKS', 'fixer'],
    ['CHECKS', 'guard'],
    ['REVIEW', 'reviewer'],
    ['COMMIT', 'delivery'],
    ['COMMITTED', 'delivery'],
    ['PUSH', 'delivery'],
    ['PULL_REQUEST', 'delivery'],
    ['WAITING_CAPACITY', 'pantry'],
    ['ALGO_NOVO', 'queue'],
  ])('%s → %s', (stage, spot) => {
    expect(stageToSpot(job(stage), false)).toBe(spot);
  });
  test('waiting for the operator: asked, or failed with an open decision', () => {
    expect(stageToSpot(job('WAITING_INPUT', 'WAITING'), true)).toBe('waiting');
    expect(stageToSpot(job('TESTS', 'FAILED'), true)).toBe('waiting');
  });
  test('done with a PR goes to the mural; the rest leaves the office', () => {
    expect(stageToSpot(job('DONE', 'SUCCESS', 'https://pr/1'), false)).toBe('mural');
    expect(stageToSpot(job('DONE', 'SUCCESS'), false)).toBeNull();
    expect(stageToSpot(job('TESTS', 'FAILED'), false)).toBeNull();
    expect(stageToSpot(job('AGENT', 'CANCELLED'), false)).toBeNull();
  });
});
describe('officeModel', () => {
  test('one folder per task in the office, at its spot', () => {
    const model = officeModel(
      [
        task({ id: 'a', key: 'PF-1', stage: 'TESTS' }),
        task({ id: 'b', key: 'PF-2', status: 'CANCELLED' }),
      ],
      [],
    );
    expect(model.folders.map((f) => [f.taskId, f.key, f.spot])).toEqual([['a', 'PF-1', 'tester']]);
  });
  test('a task with its PR and a revision running follows the revision (focus 1)', () => {
    const revision = { id: 'r1', number: 1, status: 'RUNNING', stage: 'CHECKS' } as RevisionView;
    const model = officeModel(
      [task({ status: 'SUCCESS', stage: 'DONE', prUrl: 'https://pr/1', revisions: [revision] })],
      [],
    );
    expect(model.folders[0].spot).toBe('guard');
  });
  test('a failure with an open decision waits at the counter', () => {
    const model = officeModel(
      [task({ status: 'FAILED', stage: 'TESTS' })],
      [{ id: 'd', taskId: 't1', status: 'open' } as DecisionView],
    );
    expect(model.folders[0].spot).toBe('waiting');
  });
  test('the busy desk shows the card and the AI of the last attempt', () => {
    const model = officeModel(
      [
        task({
          stage: 'AGENT',
          agentAttempts: [
            { credential: 'chatgpt', provider: 'codex', outcome: 'quota' },
            { credential: 'claude-max', provider: 'claude', model: 'opus', outcome: 'success' },
          ],
        }),
      ],
      [],
    );
    expect(model.desks.find((d) => d.spot === 'coder')).toEqual({
      spot: 'coder',
      busy: true,
      taskId: 't1',
      key: 'PF-1',
      ai: 'claude-max · opus',
    });
    expect(model.desks.find((d) => d.spot === 'tester')).toEqual({ spot: 'tester', busy: false });
  });
  test('a queued task does not make a desk busy', () => {
    const model = officeModel([task({ status: 'PENDING', stage: 'QUEUED' })], []);
    expect(model.desks.every((d) => !d.busy)).toBe(true);
  });
  test('the mural keeps the 8 newest PRs', () => {
    const done = Array.from({ length: 10 }, (_, i) =>
      task({
        id: `p${i}`,
        key: `PF-${i}`,
        status: 'SUCCESS',
        stage: 'DONE',
        prUrl: `https://pr/${i}`,
        updatedAt: `2026-10-06T10:${String(i).padStart(2, '0')}:00Z`,
      }),
    );
    const mural = officeModel(done, []).folders.filter((f) => f.spot === 'mural');
    expect(mural).toHaveLength(8);
    expect(mural.map((f) => f.key)).not.toContain('PF-0');
    expect(mural.map((f) => f.key)).not.toContain('PF-1');
  });
});
describe('room', () => {
  test('every spot, character and prop is inside the room', () => {
    for (const spot of Object.values(SPOTS)) {
      expect(inside(spot)).toBe(true);
      expect(inside(spot.labelAt)).toBe(true);
      if (spot.character) expect(inside(spot.character)).toBe(true);
      if (spot.prop) expect(inside(spot.prop)).toBe(true);
    }
  });
  test('the floor plan covers the room with walls around it and two doors', () => {
    const tiles = floorPlan();
    expect(tiles).toHaveLength(MAP_W * MAP_H);
    const at = (x: number, y: number) => tiles.find((t) => t.x === x && t.y === y)!;
    expect(at(0, 0).frame).toBe(40);
    expect(at(MAP_W - 1, 5).frame).toBe(40);
    expect(at(5, 5).frame).not.toBe(40);
    expect(tiles.filter((t) => t.frame === 46)).toHaveLength(2);
  });
});
describe('demo', () => {
  test('demo folders walk through the office as the steps advance', () => {
    const first = demoModel(0);
    const next = demoModel(1);
    expect(first.folders.length).toBeGreaterThan(0);
    expect(first.folders.every((f) => f.key.startsWith('DEMO-'))).toBe(true);
    expect(next.folders.map((f) => f.spot)).not.toEqual(first.folders.map((f) => f.spot));
  });
});

// Rectangles in tile units (centers at the coordinates): what is drawn must not overlap.
// Monospace glyphs are 0.6 em wide; sizes in tiles (16 px) from the scene's fonts.
const KEY_CHAR = (0.6 * KEY_FONT) / 16;
const LABEL_CHAR = (0.6 * LABEL_FONT) / 16;
const LABEL_HEIGHT = (LABEL_FONT + 2) / 16;
type Rect = { name: string; x0: number; x1: number; y0: number; y1: number };
const folderRect = (name: string, f: { x: number; y: number }): Rect => ({
  name,
  // Card key under the icon: up to 8 characters of the key font, plus its outline.
  x0: f.x - (8 * KEY_CHAR + 0.1) / 2,
  x1: f.x + (8 * KEY_CHAR + 0.1) / 2,
  y0: f.y - 0.5,
  y1: f.y + 0.8,
});
const spriteRect = (name: string, s: { x: number; y: number }): Rect => ({
  name,
  x0: s.x - 0.5,
  x1: s.x + 0.5,
  y0: s.y - 0.5,
  y1: s.y + 0.5,
});
const labelRect = (name: string, text: string, at: { x: number; y: number }): Rect => ({
  name,
  x0: at.x - (text.length * LABEL_CHAR + 0.2) / 2,
  x1: at.x + (text.length * LABEL_CHAR + 0.2) / 2,
  y0: at.y,
  y1: at.y + LABEL_HEIGHT,
});
const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const STAGE_OF: Partial<Record<SpotId, Partial<TaskView>>> = {
  queue: { status: 'PENDING', stage: 'QUEUED' },
  architect: { stage: 'PLANNING' },
  coder: { stage: 'AGENT' },
  tester: { stage: 'TESTS' },
  fixer: { stage: 'FIXING' },
  guard: { stage: 'CHECKS' },
  reviewer: { stage: 'REVIEW' },
  delivery: { stage: 'PUSH' },
  waiting: { status: 'WAITING', stage: 'WAITING_INPUT' },
  pantry: { status: 'PENDING', stage: 'WAITING_CAPACITY' },
  mural: { status: 'SUCCESS', stage: 'DONE', prUrl: 'https://pr/x' },
};
/** 20 tasks at every spot, with long card keys. */
const crowd = () =>
  Object.entries(STAGE_OF).flatMap(([spot, over]) =>
    Array.from({ length: 20 }, (_, i) =>
      task({ id: `${spot}-${i}`, key: `PF-${24000 + i}`, ...over }),
    ),
  );
describe('a crowded office stays readable (review finding 1)', () => {
  test('each spot shows a few folders and counts the rest', () => {
    const model = officeModel(crowd(), []);
    const at = (spot: SpotId) => model.folders.filter((f) => f.spot === spot).length;
    expect(at('tester')).toBe(3);
    expect(at('queue')).toBe(6);
    expect(at('mural')).toBe(8);
    expect(model.extra.tester).toBe(17);
    expect(model.extra.queue).toBe(14);
    expect(model.extra.mural).toBeUndefined();
  });
  test('folders, labels, characters and props never overlap and stay off the walls', () => {
    const { folders } = officeModel(crowd(), []);
    const rects: Rect[] = folders.map((f) => folderRect(`folder ${f.taskId}`, f));
    for (const spot of Object.values(SPOTS)) {
      rects.push(labelRect(`label ${spot.id}`, `${spot.label} +99`, spot.labelAt));
      if (spot.character) rects.push(spriteRect(`character ${spot.id}`, spot.character));
      // The mural plaque hangs on the wall.
      if (spot.prop && spot.prop.y >= 1) rects.push(spriteRect(`prop ${spot.id}`, spot.prop));
    }
    const clashes = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        if (overlap(rects[i], rects[j])) clashes.push(`${rects[i].name} × ${rects[j].name}`);
    expect(clashes).toEqual([]);
    const off = rects.filter(
      (r) => r.x0 < 0.5 || r.x1 > MAP_W - 1.5 || r.y0 < 0.5 || r.y1 > MAP_H - 1.5,
    );
    expect(off.map((r) => r.name)).toEqual([]);
  });
  test('slots stay put when a task changes (ordered by creation)', () => {
    const a = task({ id: 'a', key: 'PF-1', stage: 'TESTS', createdAt: '2026-10-06T09:00:00Z' });
    const b = task({ id: 'b', key: 'PF-2', stage: 'TESTS', createdAt: '2026-10-06T09:30:00Z' });
    const before = officeModel([a, b], []).folders.find((f) => f.taskId === 'a')!;
    const after = officeModel([{ ...a, updatedAt: '2026-10-06T12:00:00Z' }, b], []).folders.find(
      (f) => f.taskId === 'a',
    )!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
  });
});
test('a queued revision does not hide the one running (review finding 2)', () => {
  const running = { id: 'r1', number: 1, status: 'RUNNING', stage: 'AGENT' } as RevisionView;
  const queued = { id: 'r2', number: 2, status: 'PENDING', stage: 'QUEUED' } as RevisionView;
  const model = officeModel(
    [
      task({
        status: 'SUCCESS',
        stage: 'DONE',
        prUrl: 'https://pr/1',
        revisions: [running, queued],
      }),
    ],
    [],
  );
  expect(model.folders[0].spot).toBe('coder');
  expect(model.desks.find((d) => d.spot === 'coder')?.busy).toBe(true);
});
