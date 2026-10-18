import { expect, test } from 'vitest';
import { crew, type CrewMember } from './spots';
import { seatsFor, assignSeats } from './seats';
import { officeLayout, STATIONS, corridorRoute } from './layout';
import { cameraFocus } from './camera';
import type { TaskView, RevisionView, DecisionView } from '../types';
const task = (id: string, over: Partial<TaskView> = {}): TaskView => ({
  id,
  tenantId: 'acme',
  key: `T-${id}`,
  branch: '',
  status: 'RUNNING',
  stage: 'AGENT',
  provider: 'codex',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: `2026-10-18T10:00:0${id}Z`,
  updatedAt: '2026-10-18T10:00:00Z',
  ...over,
});
const member = (id: string, tone: CrewMember['tone'] = 'working'): CrewMember => ({
  id,
  taskId: id,
  key: id,
  role: 'coder',
  tone,
});
test('crew preserves parallel tasks, decisions, exclusions and revision identity', () => {
  expect(crew([task('1'), task('2')], []).map((m) => [m.id, m.role])).toEqual([
    ['1', 'coder'],
    ['2', 'coder'],
  ]);
  expect(crew([task('1')], [{ taskId: '1', status: 'open' } as DecisionView])[0].tone).toBe(
    'waiting',
  );
  expect(
    crew(
      [
        task('1', { stage: 'QUEUED' }),
        task('2', { status: 'SUCCESS' }),
        task('3', { status: 'CANCELLED' }),
      ],
      [],
    ),
  ).toEqual([]);
  expect(
    crew(
      [
        task('1', {
          revisions: [{ number: 2, status: 'RUNNING', stage: 'REVIEW' } as RevisionView],
        }),
      ],
      [],
    )[0],
  ).toMatchObject({ id: '1#2', taskId: '1', role: 'reviewer' });
});
test('seats grow with capacity and occupancy, clamp at four and retain previous size', () => {
  expect(seatsFor(1, [member('1')])).toBe(1);
  expect(seatsFor(3, [])).toBe(3);
  expect(
    seatsFor(
      1,
      Array.from({ length: 6 }, (_, i) => member(String(i))),
    ),
  ).toBe(4);
  expect(seatsFor(1, [member('1')], 3)).toBe(3);
});
test('assignment retains seats, fills the first free slot and prioritizes working members', () => {
  const first = assignSeats([member('1'), member('2')], new Map(), 2);
  expect(assignSeats([member('2'), member('1')], first.placed, 2).placed).toEqual(first.placed);
  const moved = { ...member('1'), role: 'tester' as const };
  expect(assignSeats([moved, member('2')], first.placed, 2).placed.get('1')).toEqual({
    role: 'tester',
    seat: 0,
  });
  const all = [member('1', 'waiting'), member('2', 'error'), member('3'), member('4'), member('5')];
  const placed = assignSeats(all, new Map([['2', { role: 'coder', seat: 0 }]]), 4);
  expect(placed.overflow.coder).toBe(1);
  for (const id of ['3', '4', '5']) expect(placed.placed.has(id)).toBe(true);
});
test('one seat preserves the original room and four seats keep columns and passages separate', () => {
  const old = officeLayout(1);
  expect([old.width, old.height, old.passages, old.aisles]).toEqual([
    960,
    640,
    [318, 642],
    [245, 495, 530],
  ]);
  for (const role of Object.keys(STATIONS) as (keyof typeof STATIONS)[]) {
    expect(old.stations[role]).toMatchObject(STATIONS[role]);
    expect(old.stations[role].seats).toEqual([{ x: STATIONS[role].x, y: STATIONS[role].y + 61 }]);
  }
  const large = officeLayout(4);
  expect(large.width).toBe(1608);
  const columns = ['architect', 'coder', 'tester'] as const;
  columns.forEach((role, i) => {
    const station = large.stations[role];
    expect(new Set(station.seats.map((p) => p.x)).size).toBe(4);
    if (i < 2) {
      expect(large.passages[i]).toBeGreaterThan(station.x + 108 + 108);
      expect(large.passages[i]).toBeLessThan(large.stations[columns[i + 1]].x - 216);
    }
    for (const target of Object.values(large.stations)) {
      const route = corridorRoute(station.seats[0], target.seats[3], large);
      expect(route.at(-1)).toEqual(target.seats[3]);
      expect(
        route.every((p) => p.x >= 0 && p.x <= large.width && p.y >= 0 && p.y <= large.height),
      ).toBe(true);
    }
  });
});
test('camera shows the whole room when idle, clamps corners and fits distant points', () => {
  const view = { width: 960, height: 640 },
    world = { width: 1608, height: 640 };
  expect(cameraFocus([], view, world)).toEqual({ x: 804, y: 320, zoom: 960 / 1608 });
  expect(cameraFocus([{ x: 0, y: 0 }], view, world)).toEqual({ x: 192, y: 128, zoom: 2.5 });
  const focus = cameraFocus(
    [
      { x: 200, y: 200 },
      { x: 1300, y: 400 },
    ],
    view,
    world,
  );
  expect(focus.zoom).toBeCloseTo(960 / 1340);
  expect(focus.zoom).toBeGreaterThanOrEqual(960 / 1608);
  expect(focus.zoom).toBeLessThanOrEqual(2.5);
});

test('seat priority uses task age before identity and never retains a waiting slot over work', () => {
  const old = { ...member('9'), createdAt: '2026-10-18T10:00:00Z' };
  const newer = { ...member('1'), createdAt: '2026-10-18T11:00:00Z' };
  expect(assignSeats([newer, old], new Map(), 1).placed.has('9')).toBe(true);
  const blocked = member('waiting', 'waiting');
  const previous = assignSeats([blocked], new Map(), 1).placed;
  expect([...assignSeats([blocked, old], previous, 1).placed.keys()]).toEqual(['9']);
});
test('expanded routes clear station desks and the planning table for every seat', () => {
  for (const seats of [1, 2, 3, 4]) {
    const layout = officeLayout(seats),
      extra = (seats - 1) * 72;
    const targets = Object.values(layout.stations).flatMap((s) => [s.seats[0], s.seats.at(-1)!]);
    const furniture = [
      ...Object.values(layout.stations).map((s) => ({
        x0: s.x - 89 - extra / 2,
        x1: s.x + 89 + extra / 2,
        y0: s.y - 50,
        y1: s.y + 45,
      })),
      { x0: layout.planning.x - 160, x1: layout.planning.x + 160, y0: 265, y1: 349 },
    ];
    for (const from of targets)
      for (const to of targets) {
        const route = [from, ...corridorRoute(from, to, layout)];
        for (let i = 1; i < route.length; i++)
          for (const r of furniture) {
            const a = route[i - 1],
              b = route[i];
            const intersects =
              a.x === b.x
                ? a.x > r.x0 && a.x < r.x1 && Math.min(a.y, b.y) < r.y1 && Math.max(a.y, b.y) > r.y0
                : a.y > r.y0 &&
                  a.y < r.y1 &&
                  Math.min(a.x, b.x) < r.x1 &&
                  Math.max(a.x, b.x) > r.x0;
            expect(intersects).toBe(false);
          }
      }
  }
  expect(
    Object.fromEntries(
      Object.entries(officeLayout(1).stations).map(([r, s]) => [r, [s.x, s.y, s.frame]]),
    ),
  ).toEqual({
    architect: [180, 170, 84],
    coder: [480, 170, 85],
    tester: [780, 170, 86],
    fixer: [180, 420, 88],
    guard: [480, 420, 96],
    reviewer: [780, 420, 99],
  });
});
