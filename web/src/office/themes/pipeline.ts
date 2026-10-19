import type { OfficeLayout } from '../layout';
import { ROLES } from '../spots';
import { studio } from './studio';
import { decorateModern } from './paint';
import type { OfficeTheme } from './types';
function layout(seats: number): OfficeLayout {
  seats = Math.max(1, Math.min(4, Math.floor(seats)));
  const stationWidth = 216 + (seats - 1) * 72;
  const width = 400 + 6 * stationWidth + 5 * 48;
  const frames = [84, 85, 86, 88, 96, 99];
  const stations = Object.fromEntries(
    ROLES.map((role, i) => {
      const x = 200 + stationWidth / 2 + i * (stationWidth + 48),
        y = 170;
      return [
        role,
        {
          x,
          y,
          frame: frames[i],
          desk: { x: x - stationWidth / 2, y: y - 52, w: stationWidth, h: 108 },
          seats: Array.from({ length: seats }, (_, s) => ({
            x: x + (s - (seats - 1) / 2) * 72,
            y: y + 61,
          })),
        },
      ];
    }),
  ) as OfficeLayout['stations'];
  return {
    width,
    height: 420,
    seats,
    stationWidth,
    stations,
    passages: Array.from(
      { length: 5 },
      (_, i) => 200 + stationWidth + 24 + i * (stationWidth + 48),
    ),
    aisles: [260],
    rest: Array.from({ length: 6 }, (_, i) => ({ x: 90 + i * 35, y: 280 })),
    mural: { x: 355, y: 65 },
    waiting: { x: 558, y: 64 },
    planning: { x: width / 2, y: 65 },
    queue: { x: 100, y: 160 },
    entrance: { x: 100, y: 260 },
    pantry: { x: 200, y: 380 },
    chest: { x: width - 100, y: 170 },
    delivery: { x: width - 100, y: 260 },
    exit: { x: width - 80, y: 280 },
    doors: [
      { x: 40, y: 260 },
      { x: width - 32, y: 260 },
    ],
    plants: [
      { x: 50, y: 100 },
      { x: width - 50, y: 100 },
    ],
    windows: [
      { x: 75, y: 39 },
      { x: width - 75, y: 39 },
    ],
    lamps: [],
    bookcases: [],
    decor: { beltY: 310, muralLabelOffset: 0 },
  };
}
export const pipeline: OfficeTheme = {
  id: 'pipeline',
  layout,
  palette: {
    ...studio.palette,
    floor: 0x525e68,
    plank: 0x66737d,
    plankAlt: 0x6e7c86,
    grain: 0x5f6c75,
    wall: 0x93a4ab,
    wallShade: 0x82959d,
    rug: 0x3d5862,
    rugInner: 0x57717b,
    desk: 0xc8d8d9,
    deskEdge: 0x364e5a,
  },
  decorate(p, l) {
    decorateModern(p, l);
    const y = Number(l.decor.beltY);
    p.rect(300, y - 6, l.width - 390, 36, 0x263943);
    p.rect(300, y, l.width - 390, 24, 0x344c58);
    for (let x = 304; x < l.width - 100; x += 32) {
      p.rect(x, y + 3, 22, 18, 0x68818b).setData('officeBelt', true);
      p.rect(x + 2, y + 7, 16, 3, 0xa6bab7);
    }
    for (let x = 310; x < l.width - 100; x += 128)
      p.polygon(x, y + 42, [0, 0, 8, 0, 8, 6, 13, 6, 4, 14, -5, 6, 0, 6], 0xc6b578);
  },
};
