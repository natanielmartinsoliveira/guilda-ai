import type { GuildRole } from './spots';
const BASE_STATIONS: Record<GuildRole, { x: number; y: number; frame: number }> = {
  architect: { x: 180, y: 170, frame: 84 },
  coder: { x: 480, y: 170, frame: 85 },
  tester: { x: 780, y: 170, frame: 86 },
  fixer: { x: 180, y: 420, frame: 88 },
  guard: { x: 480, y: 420, frame: 96 },
  reviewer: { x: 780, y: 420, frame: 99 },
};
export type Point = { x: number; y: number };
/** Interior passages between station columns, wide enough for the sprite and central table. */
export function officeLayout(seats: number) {
  seats = Math.max(1, Math.min(4, Math.floor(seats)));
  const extra = (seats - 1) * 72;
  const width = 960 + extra * 3;
  const stations = Object.fromEntries(
    Object.entries(BASE_STATIONS).map(([role, s], i) => {
      const x = s.x + extra * ((i % 3) + 0.5);
      return [
        role,
        {
          ...s,
          x,
          seats: Array.from({ length: seats }, (_, seat) => ({
            x: x + (seat - (seats - 1) / 2) * 72,
            y: s.y + 61,
          })),
        },
      ];
    }),
  ) as Record<GuildRole, { x: number; y: number; frame: number; seats: Point[] }>;
  const center = (width - 960) / 2,
    right = width - 960;
  return {
    width,
    height: 640,
    seats,
    stationWidth: 216 + extra,
    stations,
    passages: [318 + extra, 642 + extra * 2],
    aisles: [245, 495, 530],
    rest: Array.from({ length: 6 }, (_, i) => ({ x: 650 + right + i * 35, y: 539 })),
    mural: { x: 355 + center, y: 65 },
    waiting: { x: 558 + center, y: 64 },
    planning: { x: 480 + center, y: 304 },
    queue: { x: 184, y: 581 },
    entrance: { x: 184, y: 539 },
    pantry: { x: 755 + right, y: 613 },
    chest: { x: 490 + center, y: 581 },
    delivery: { x: 490 + center, y: 539 },
    exit: { x: 90, y: 590 },
    doors: [
      { x: 80, y: 612 },
      { x: width - 16, y: 530 },
    ],
    plants: [
      { x: 55, y: 110 },
      { x: width - 50, y: 110 },
      { x: 55, y: 530 },
      { x: width - 55, y: 530 },
    ],
    bookcases: [
      { x: 130, y: 39 },
      { x: 650 + right, y: 39 },
    ],
    windows: [
      { x: 75, y: 39 },
      { x: width - 75, y: 39 },
    ],
    lamps: [
      { x: 60, y: 150 },
      { x: width - 60, y: 150 },
      { x: 60, y: 390 },
      { x: width - 60, y: 390 },
    ],
  };
}
export type OfficeLayout = ReturnType<typeof officeLayout>;
const base = officeLayout(1);
export const WIDTH = base.width,
  HEIGHT = base.height,
  STATIONS = base.stations,
  PASSAGES = base.passages,
  AISLES = base.aisles;
const nearestAisle = (point: Point, layout: OfficeLayout) =>
  layout.aisles.reduce<number>(
    (nearest, y) => (Math.abs(point.y - y) < Math.abs(point.y - nearest) ? y : nearest),
    layout.aisles[0],
  );
/** Orthogonal routes use the shortest interior passage instead of circling the room's wall. */
export function corridorRoute(from: Point, to: Point, layout = officeLayout(1)): Point[] {
  const { passages: PASSAGES, aisles: AISLES } = layout;
  const a = nearestAisle(from, layout),
    b = nearestAisle(to, layout);
  const inPassage =
    PASSAGES.some((x) => Math.abs(from.x - x) < 0.01) && from.y >= AISLES[0] && from.y <= AISLES[2];
  const passage = PASSAGES.reduce<number>(
    (best, x) =>
      Math.abs(from.x - x) + Math.abs(to.x - x) < Math.abs(from.x - best) + Math.abs(to.x - best)
        ? x
        : best,
    PASSAGES[0],
  );
  const points = inPassage
    ? [{ x: from.x, y: b }, { x: to.x, y: b }, to]
    : [
        { x: from.x, y: a },
        ...(a === b
          ? []
          : [
              { x: passage, y: a },
              { x: passage, y: b },
            ]),
        { x: to.x, y: b },
        to,
      ];
  return points.filter((p, index) => {
    const previous = index ? points[index - 1] : from;
    return p.x !== previous.x || p.y !== previous.y;
  });
}
