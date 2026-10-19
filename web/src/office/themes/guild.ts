import type { OfficeLayout } from '../layout';
import type { GuildRole } from '../spots';
import type { OfficeTheme } from './types';
import { guildPalette, decorateGuild } from './paint';
const BASE_STATIONS: Record<GuildRole, { x: number; y: number; frame: number }> = {
  architect: { x: 180, y: 170, frame: 84 },
  coder: { x: 480, y: 170, frame: 85 },
  tester: { x: 780, y: 170, frame: 86 },
  fixer: { x: 180, y: 420, frame: 88 },
  guard: { x: 480, y: 420, frame: 96 },
  reviewer: { x: 780, y: 420, frame: 99 },
};
/** Interior passages between station columns, wide enough for the sprite and central table. */
function layout(seats: number): OfficeLayout {
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
          desk: { x: x - (216 + extra) / 2, y: s.y - 52, w: 216 + extra, h: 108 },
          seats: Array.from({ length: seats }, (_, seat) => ({
            x: x + (seat - (seats - 1) / 2) * 72,
            y: s.y + 61,
          })),
        },
      ];
    }),
  ) as OfficeLayout['stations'];
  const center = (width - 960) / 2,
    right = width - 960;
  return {
    decor: {},
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

export const guild: OfficeTheme = {
  id: 'guild',
  layout,
  palette: guildPalette,
  decorate: decorateGuild,
};
