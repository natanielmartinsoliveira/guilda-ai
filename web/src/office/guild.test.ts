import { expect, test } from 'vitest';
import { corridorRoute, PASSAGES, STATIONS } from './layout';
import { guildState, ROLES } from './spots';
import type { TaskView, RevisionView, DecisionView } from '../types';
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'a',
  tenantId: 'company',
  branch: '',
  status: 'RUNNING',
  stage: 'AGENT',
  provider: 'codex',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: '2026-10-07T12:00:00Z',
  updatedAt: '2026-10-07T12:00:00Z',
  ...over,
});
test('counts concurrent executions and preserves every mission in its station', () => {
  const guild = guildState(
    [task(), task({ id: 'b' }), task({ id: 'c', status: 'PENDING', stage: 'QUEUED' })],
    [],
  );
  expect(guild.active).toBe(2);
  expect(guild.agents.find((a) => a.role === 'coder')?.tasks).toHaveLength(2);
  expect(guild.queued).toBe(1);
});
test('waiting and failures remain visible and never animate as work', () => {
  const guild = guildState(
    [task(), task({ id: 'b', stage: 'TESTS', status: 'FAILED' })],
    [{ id: 'd', taskId: 'a', status: 'open' } as DecisionView],
  );
  expect(guild.active).toBe(0);
  expect(guild.agents.find((a) => a.role === 'coder')?.status).toBe('Aguardando');
  expect(guild.agents.find((a) => a.role === 'tester')?.status).toBe('Erro');
});
test('a revision supplies the current role and capacity waits preserve known identity', () => {
  const guild = guildState(
    [
      task({
        status: 'SUCCESS',
        stage: 'DONE',
        revisions: [
          {
            number: 1,
            status: 'RUNNING',
            stage: 'FIXING',
            agentAttempts: [
              {
                role: 'fixer',
                credential: 'real-credential',
                outcome: 'success',
                provider: 'codex',
              },
            ],
          } as RevisionView,
        ],
      }),
      task({
        id: 'b',
        stage: 'WAITING_CAPACITY',
        status: 'PENDING',
        agentAttempts: [
          { role: 'planner', credential: 'planner-id', outcome: 'quota', provider: 'codex' },
        ],
      }),
    ],
    [],
  );
  expect(guild.agents.find((a) => a.role === 'fixer')?.name).toBe('real-credential');
  expect(guild.agents.find((a) => a.role === 'architect')?.status).toBe('Aguardando');
  expect(guild.active).toBe(1);
});
test('initial empty stations have no fabricated missions or names', () => {
  expect(guildState([], []).agents.every((a) => a.status === 'Livre' && !a.task)).toBe(true);
  expect(guildState([], []).completed).toEqual([]);
});
test('routes between every station and the pantry clear furniture in both directions', () => {
  const destinations = [
    ...ROLES.map((role) => ({ x: STATIONS[role].x, y: STATIONS[role].y + 61 })),
    ...ROLES.map((_, i) => ({ x: 650 + i * 35, y: 539 })),
  ];
  destinations.forEach((source) => {
    for (const target of destinations) {
      const start = source,
        end = target;
      const route = [start, ...corridorRoute(start, end)];
      for (let j = 1; j < route.length; j++) {
        const a = route[j - 1],
          b = route[j];
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const furniture of Object.values(STATIONS)) {
          // Desks including the avatar's footprint, plus the central collaboration table.
          const intersects =
            a.x === b.x
              ? a.x > furniture.x - 85 &&
                a.x < furniture.x + 85 &&
                Math.min(a.y, b.y) < furniture.y + 42 &&
                Math.max(a.y, b.y) > furniture.y - 50
              : a.y > furniture.y - 50 &&
                a.y < furniture.y + 42 &&
                Math.min(a.x, b.x) < furniture.x + 85 &&
                Math.max(a.x, b.x) > furniture.x - 85;
          expect(intersects).toBe(false);
        }
        const tableIntersects =
          a.x === b.x
            ? a.x > 322 && a.x < 638 && Math.min(a.y, b.y) < 382 && Math.max(a.y, b.y) > 268
            : a.y > 268 && a.y < 382 && Math.min(a.x, b.x) < 638 && Math.max(a.x, b.x) > 322;
        expect(tableIntersects).toBe(false);
        // The passage runs in front of the sofa, allowing for the character's footprint.
        const sofaIntersects =
          a.x === b.x
            ? a.x > 619 && a.x < 861 && Math.min(a.y, b.y) < 614 && Math.max(a.y, b.y) > 547
            : a.y > 547 && a.y < 614 && Math.min(a.x, b.x) < 861 && Math.max(a.x, b.x) > 619;
        expect(sofaIntersects).toBe(false);
      }
    }
  });
});

test('characters cross the interior passages between stage desks, never the outer wall', () => {
  for (const from of [
    { x: 180, y: 231 },
    { x: 480, y: 231 },
    { x: 780, y: 231 },
  ]) {
    for (const to of [
      { x: 180, y: 481 },
      { x: 480, y: 481 },
      { x: 780, y: 481 },
    ]) {
      const route = [from, ...corridorRoute(from, to)];
      const vertical = route
        .slice(1)
        .filter((p, i) => p.y !== route[i].y && Math.abs(p.y - route[i].y) > 100);
      expect(vertical).toHaveLength(1);
      expect(PASSAGES).toContain(vertical[0].x);
      expect(route.every((p) => p.x >= PASSAGES[0] || p.x === from.x || p.x === to.x)).toBe(true);
    }
  }
  expect(corridorRoute({ x: 780, y: 231 }, { x: 780, y: 481 })).toContainEqual({ x: 642, y: 245 });
  expect(corridorRoute({ x: 180, y: 231 }, { x: 180, y: 481 })).toContainEqual({ x: 318, y: 245 });
});
test('a state change halfway through a passage continues toward the new station', () => {
  expect(corridorRoute({ x: 642, y: 400 }, { x: 480, y: 231 })).toEqual([
    { x: 642, y: 245 },
    { x: 480, y: 245 },
    { x: 480, y: 231 },
  ]);
});
