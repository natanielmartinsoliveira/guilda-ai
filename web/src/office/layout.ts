import type { GuildRole } from './spots';
export const WIDTH = 960;
export const HEIGHT = 640;
export const STATIONS: Record<GuildRole, { x: number; y: number; frame: number }> = {
  architect: { x: 180, y: 170, frame: 84 },
  coder: { x: 480, y: 170, frame: 85 },
  tester: { x: 780, y: 170, frame: 86 },
  fixer: { x: 180, y: 420, frame: 88 },
  guard: { x: 480, y: 420, frame: 96 },
  reviewer: { x: 780, y: 420, frame: 99 },
};
export type Point = { x: number; y: number };
/** Interior passages between station columns, wide enough for the sprite and central table. */
export const PASSAGES = [318, 642] as const;
const AISLES = [245, 495, 530] as const;
const nearestAisle = (point: Point) =>
  AISLES.reduce<number>(
    (nearest, y) => (Math.abs(point.y - y) < Math.abs(point.y - nearest) ? y : nearest),
    AISLES[0],
  );
/** Orthogonal routes use the shortest interior passage instead of circling the room's wall. */
export function corridorRoute(from: Point, to: Point): Point[] {
  const a = nearestAisle(from),
    b = nearestAisle(to);
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
