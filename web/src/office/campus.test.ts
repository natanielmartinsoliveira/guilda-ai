import { expect, test } from 'vitest';
import {
  campusModel,
  campusLayout,
  campusFocusPoints,
  campusCameraFocus,
  campusGuild,
  companyCaption,
} from './campus';
import { officeLayout } from './layout';
import type { Tenant, TaskView, DecisionView } from '../types';
const tenant = (id: string, concurrency = 1): Tenant => ({
  id,
  name: id,
  concurrency,
  providers: [],
  jira: false,
  projects: [],
});
const task = (id: string, tenantId: string): TaskView => ({
  id,
  tenantId,
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
  createdAt: '2026-10-18T12:00:00Z',
  updatedAt: '2026-10-18T12:00:00Z',
});
test('campus models isolate crew and decisions, including identical ids in different companies', () => {
  const rooms = campusModel(
    [tenant('acme'), tenant('globex', 3)],
    [task('same', 'acme'), task('same', 'globex')],
    [{ id: 'd', tenantId: 'globex', taskId: 'same', status: 'open' } as DecisionView],
  );
  expect(rooms.map((r) => [r.tenantId, r.seats, r.model.crew.length])).toEqual([
    ['acme', 1, 1],
    ['globex', 3, 1],
  ]);
  expect(rooms[0].model.crew[0].tone).toBe('working');
  expect(rooms[1].model.crew[0].tone).toBe('waiting');
  expect(rooms[0].model.guild!.waiting).toBe(0);
  expect(rooms[1].model.guild!.waiting).toBe(1);
});
test('one room has the identical origin and size, and four rooms form a nonoverlapping three-column campus', () => {
  const one = campusLayout([{ tenantId: 'acme', seats: 2 }]);
  expect(one.rooms[0].offset).toEqual({ x: 0, y: 0 });
  expect([one.width, one.height]).toEqual([officeLayout(2).width, 640]);
  const inputs = ['acme', 'globex', 'initech', 'acme-2'].map((tenantId) => ({
    tenantId,
    seats: 1,
  }));
  const layout = campusLayout(inputs);
  expect(new Set(layout.rooms.slice(0, 3).map((r) => r.offset.y)).size).toBe(1);
  expect(layout.rooms[3].offset.y).toBeGreaterThanOrEqual(layout.rooms[0].offset.y + 640 + 96);
  for (let i = 0; i < layout.rooms.length; i++)
    for (let j = i + 1; j < layout.rooms.length; j++) {
      const a = layout.rooms[i],
        b = layout.rooms[j];
      expect(
        b.offset.x >= a.offset.x + a.layout.width + 96 ||
          a.offset.x >= b.offset.x + b.layout.width + 96 ||
          b.offset.y >= a.offset.y + a.layout.height + 96 ||
          a.offset.y >= b.offset.y + b.layout.height + 96,
      ).toBe(true);
    }
  const larger = campusLayout(inputs.map((r, i) => ({ ...r, seats: i === 0 ? 4 : 1 })));
  expect(larger.rooms[1].offset.x - layout.rooms[1].offset.x).toBe(648);
  expect(larger.width).toBeGreaterThan(layout.width);
});
test('campus camera points add room offsets, prioritize walking and use the whole world in overview', () => {
  const rooms = campusLayout([
    { tenantId: 'acme', seats: 1 },
    { tenantId: 'globex', seats: 1 },
  ]).rooms;
  const actors = [
    { tenantId: 'acme', x: 180, y: 231, moving: false, working: true },
    { tenantId: 'globex', x: 480, y: 231, moving: true, working: true },
  ];
  expect(campusFocusPoints(rooms, actors)).toEqual([
    { x: rooms[1].offset.x + 480, y: rooms[1].offset.y + 231 },
  ]);
  expect(
    campusFocusPoints(
      rooms,
      actors.map((a) => ({ ...a, moving: false })),
    ),
  ).toHaveLength(2);
  expect(campusFocusPoints(rooms, actors, true)).toEqual([]);
});
test('mobile idle follow focuses the first room with tasks, while overview still fits the campus', () => {
  const rooms = campusModel(
    [tenant('acme'), tenant('globex')],
    [{ ...task('2', 'globex'), status: 'FAILED' }],
    [],
  );
  const layout = campusLayout(rooms),
    view = { width: 360, height: 240 };
  const follow = campusCameraFocus(rooms, layout, [], view);
  const overview = campusCameraFocus(rooms, layout, [], view, true);
  expect(follow.zoom).toBeCloseTo(360 / 960);
  expect(overview.zoom).toBeCloseTo(360 / layout.width);
  expect(follow.x).toBe(layout.rooms[1].offset.x + 480);
});
test('station summaries use the most urgent company without losing any tasks', () => {
  const rooms = campusModel(
    [tenant('acme'), tenant('globex')],
    [task('1', 'acme'), { ...task('2', 'globex'), status: 'FAILED' }],
    [],
  );
  const guild = campusGuild(rooms);
  expect(guild.agents.find((a) => a.role === 'coder')).toMatchObject({
    tone: 'error',
    tasks: expect.any(Array),
  });
  expect(guild.agents.find((a) => a.role === 'coder')!.tasks).toHaveLength(2);
  expect(guild.active).toBe(1);
});

test('company signs limit long names without losing counts or shortening ordinary names', () => {
  expect(companyCaption('Acme', 3)).toBe('Acme ◆ 3');
  expect(companyCaption('Acme '.repeat(40), 8)).toMatch(/… ◆ 8$/);
  expect(companyCaption('Acme '.repeat(40), 8).length).toBeLessThan(50);
});
