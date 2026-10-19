import type { OfficeLayout } from '../layout';
import type { RoomPainter, OfficePalette } from './types';
export const guildPalette: OfficePalette = {
  planningRug: 0x674d77,
  planningRugInner: 0x856493,
  planningEdge: 0x4e342b,
  planningDesk: 0xb48a5b,
  queue: 0x513d30,
  queuePaper: 0xd9c49b,
  coffeeTop: 0xb28758,
  coffeeCup: 0xe5cf9d,
  floor: 0x383542,
  plank: 0x866045,
  plankAlt: 0x916b4d,
  grain: 0xa67c56,
  wall: 0x5d5864,
  wallShade: 0x504b57,
  rug: 0x594750,
  rugInner: 0x756078,
  desk: 0xb08a60,
  deskEdge: 0x493329,
  board: 0x503c30,
  boardInner: 0xbe9c70,
  paper: 0xe8d5a5,
  waiting: 0x645077,
  waitingText: '#ffe0a6',
  sofa: 0x4b6558,
  sofaBack: 0x78967e,
  coffee: 0x53382d,
  chest: 0x7c5338,
  chestLid: 0xd6ad62,
  chestLatch: 0xe1c475,
  label: '#fff2d9',
  labelBackground: '#30293c',
  status: { working: '#a9efbc', waiting: '#ffe09c', error: '#ffadad', idle: '#d6c7ee' },
  plate: '#30293c',
};
export function plant(p: RoomPainter, x: number, y: number, modern = false) {
  p.rect(x - 10, y, 20, 18, modern ? 0xc9d5d9 : 0x9c6455);
  p.rect(x - 15, y - 22, 30, 22, 0x365f48);
  p.rect(x - 8, y - 34, 16, 34, 0x648e59);
  p.rect(x + 3, y - 25, 13, 12, 0x8ba86a);
}
export function decorateGuild(p: RoomPainter, l: OfficeLayout) {
  for (const { x } of l.windows) {
    p.rect(x - 20, 39, 40, 53, 0x352d43);
    p.rect(x - 15, 44, 30, 42, 0x768d91);
    p.rect(x - 2, 44, 4, 42, 0xc3a274);
    p.rect(x - 15, 62, 30, 4, 0xc3a274);
  }
  for (const { x, y } of l.lamps) {
    p.circle(x, y, 40, 0xffc676, 0.08);
    p.rect(x - 6, y - 8, 12, 20, 0xdfb069);
    p.rect(x - 3, y - 12, 6, 12, 0xffe6a3);
  }
  for (const { x, y } of l.plants) plant(p, x, y);
  for (const { x, y } of l.bookcases) {
    p.rect(x, y, 78, 38, 0x382c29);
    for (let i = 0; i < 9; i++)
      p.rect(x + 5 + i * 8, y + 5, 5, 23, [0x8a6999, 0x62856c, 0xc09d6a][i % 3]);
    p.rect(x, y + 30, 78, 6, 0xa07b54);
  }
}
export function decorateModern(p: RoomPainter, l: OfficeLayout) {
  // Coffee machine and the lit decision panel sit behind the common functional shapes.
  p.rect(l.pantry.x + 103, l.pantry.y - 70, 32, 34, 0x425966);
  p.rect(l.pantry.x + 108, l.pantry.y - 65, 13, 7, 0xb8dacc);
  p.rect(l.pantry.x + 120, l.pantry.y - 54, 6, 9, 0x273f4a);
  p.circle(l.waiting.x, l.waiting.y, 66, 0xd4e9a8, 0.08);
  for (const { x, y } of l.windows) {
    p.rect(x - 28, y, 56, 56, 0xb6cbd3);
    p.rect(x - 23, y + 4, 46, 45, 0xd3edf2);
    p.rect(x - 2, y + 4, 4, 45, 0xf6fafb);
    p.rect(x - 23, y + 23, 46, 3, 0xf6fafb);
  }
  for (const { x, y } of l.plants) plant(p, x, y, true);
  for (const { x, y } of l.bookcases) {
    p.rect(x, y, 78, 38, 0xd2dce0);
    p.rect(x + 4, y + 4, 70, 24, 0x6d8790);
    for (let i = 0; i < 7; i++)
      p.rect(x + 8 + i * 9, y + 8, 6, 18, [0x67978e, 0xa598bb, 0xc4ad75][i % 3]);
  }
  for (const { x, y } of l.lamps) {
    p.circle(x, y, 30, 0xffffff, 0.06);
    p.rect(x - 5, y - 10, 10, 20, 0xf6f2cf);
  }
}
