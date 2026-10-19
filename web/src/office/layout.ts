import type { GuildRole } from './spots';
import { guild } from './themes/guild';
export type Point = { x: number; y: number };
export interface OfficeLayout {
  width: number;
  height: number;
  seats: number;
  stationWidth: number;
  stations: Record<
    GuildRole,
    Point & { frame: number; seats: Point[]; desk: { x: number; y: number; w: number; h: number } }
  >;
  passages: number[];
  aisles: number[];
  rest: Point[];
  mural: Point;
  waiting: Point;
  planning: Point;
  queue: Point;
  entrance: Point;
  pantry: Point;
  chest: Point;
  delivery: Point;
  exit: Point;
  doors: Point[];
  plants: Point[];
  bookcases: Point[];
  windows: Point[];
  lamps: Point[];
  decor: Record<string, unknown>;
}
/** Compatibility alias for the original guild geometry. */
export const officeLayout = guild.layout;
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
    PASSAGES.some((x) => Math.abs(from.x - x) < 0.01) &&
    from.y >= Math.min(...AISLES) &&
    from.y <= Math.max(...AISLES);
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
