import { expect, test } from 'vitest';
import { themeFor } from './index';
import { officeLayout, corridorRoute, type Point } from '../layout';
import { ROLES } from '../spots';
import { campusLayout } from '../campus';

const ids = ['guild', 'studio', 'pipeline'] as const;
test('themes resolve known ids and fall back safely', () => {
  for (const id of [undefined, 'nope']) expect(themeFor(id).id).toBe('guild');
  for (const id of ids) expect(themeFor(id).id).toBe(id);
});
test('guild preserves the original dimensions, station positions and landmarks', () => {
  const l = themeFor('guild').layout(1);
  expect([l.width, l.height, l.stationWidth, l.passages, l.aisles]).toEqual([
    960,
    640,
    216,
    [318, 642],
    [245, 495, 530],
  ]);
  expect(
    ROLES.map((r) => [l.stations[r].x, l.stations[r].y, l.stations[r].frame, l.stations[r].seats]),
  ).toEqual([
    [180, 170, 84, [{ x: 180, y: 231 }]],
    [480, 170, 85, [{ x: 480, y: 231 }]],
    [780, 170, 86, [{ x: 780, y: 231 }]],
    [180, 420, 88, [{ x: 180, y: 481 }]],
    [480, 420, 96, [{ x: 480, y: 481 }]],
    [780, 420, 99, [{ x: 780, y: 481 }]],
  ]);
  expect([
    l.mural,
    l.waiting,
    l.planning,
    l.queue,
    l.entrance,
    l.pantry,
    l.chest,
    l.delivery,
    l.exit,
    l.doors,
  ]).toEqual([
    { x: 355, y: 65 },
    { x: 558, y: 64 },
    { x: 480, y: 304 },
    { x: 184, y: 581 },
    { x: 184, y: 539 },
    { x: 755, y: 613 },
    { x: 490, y: 581 },
    { x: 490, y: 539 },
    { x: 90, y: 590 },
    [
      { x: 80, y: 612 },
      { x: 944, y: 530 },
    ],
  ]);
  for (let n = 1; n <= 4; n++) expect(themeFor('guild').layout(n)).toEqual(officeLayout(n));
});
const intersects = (a: Point, b: Point, d: { x: number; y: number; w: number; h: number }) =>
  a.x === b.x
    ? a.x > d.x && a.x < d.x + d.w && Math.min(a.y, b.y) < d.y + d.h && Math.max(a.y, b.y) > d.y
    : a.y > d.y && a.y < d.y + d.h && Math.min(a.x, b.x) < d.x + d.w && Math.max(a.x, b.x) > d.x;
for (const id of ids)
  for (let n = 1; n <= 4; n++) {
    test(`${id}, ${n} seats: desks, landmarks and every walking route fit the room`, () => {
      const l = themeFor(id).layout(n);
      const inside = (p: Point) => p.x >= 0 && p.x <= l.width && p.y >= 0 && p.y <= l.height;
      expect(l.passages.length).toBeGreaterThan(0);
      const points = ROLES.flatMap((r) => l.stations[r].seats);
      expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(6 * n);
      for (const role of ROLES) {
        const s = l.stations[role];
        expect(s.seats).toHaveLength(n);
        for (const other of ROLES.filter((r) => r !== role)) {
          const a = s.desk,
            b = l.stations[other].desk;
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(
            true,
          );
        }
      }
      for (const p of [
        ...points,
        ...l.rest,
        ...l.doors,
        l.mural,
        l.waiting,
        l.planning,
        l.queue,
        l.entrance,
        l.pantry,
        l.chest,
        l.delivery,
        l.exit,
      ])
        expect(inside(p)).toBe(true);
      for (const from of [l.entrance, l.delivery, l.exit, ...l.rest, ...points])
        for (const to of points) {
          if (from === to) continue;
          const route = [from, ...corridorRoute(from, to, l)];
          expect(route.at(-1)).toEqual(to);
          for (let i = 1; i < route.length; i++) {
            const a = route[i - 1],
              b = route[i];
            expect(inside(b)).toBe(true);
            expect(a.x === b.x || a.y === b.y).toBe(true);
            for (const role of ROLES) expect(intersects(a, b, l.stations[role].desk)).toBe(false);
            if (id === 'pipeline') expect(Math.max(a.y, b.y)).toBeLessThan(300);
          }
        }
    });
  }
test('pipeline follows role order in a shorter room and grows with capacity', () => {
  for (let n = 1; n <= 4; n++) {
    const l = themeFor('pipeline').layout(n);
    const xs = ROLES.map((r) => l.stations[r].x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(l.height).toBeLessThan(officeLayout(n).height);
    expect(l.aisles).toHaveLength(1);
    if (n > 1) expect(l.width).toBeGreaterThan(themeFor('pipeline').layout(n - 1).width);
  }
});
test('mixed campus uses the individual theme sizes and the tallest room per row', () => {
  const rooms = [
    { tenantId: 'acme', theme: 'pipeline', seats: 4 },
    { tenantId: 'globex', theme: 'guild', seats: 1 },
    { tenantId: 'initech', theme: 'studio', seats: 2 },
    { tenantId: 'acme-2', theme: 'pipeline', seats: 1 },
  ];
  const c = campusLayout(rooms);
  c.rooms.forEach((r, i) =>
    expect([r.layout.width, r.layout.height]).toEqual([
      themeFor(rooms[i].theme).layout(rooms[i].seats).width,
      themeFor(rooms[i].theme).layout(rooms[i].seats).height,
    ]),
  );
  expect(c.rooms[1].offset.x).toBe(c.rooms[0].layout.width + 96);
  expect(c.rooms[3].offset.y).toBe(96 + 640 + 96);
});
