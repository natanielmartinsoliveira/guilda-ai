import type Phaser from 'phaser';
import type { OfficeLayout } from '../layout';
export type OfficeThemeId = 'guild' | 'studio' | 'pipeline';
export interface OfficePalette {
  planningRug: number;
  planningRugInner: number;
  planningEdge: number;
  planningDesk: number;
  queue: number;
  queuePaper: number;
  coffeeTop: number;
  coffeeCup: number;
  floor: number;
  plank: number;
  plankAlt: number;
  grain: number;
  wall: number;
  wallShade: number;
  rug: number;
  rugInner: number;
  desk: number;
  deskEdge: number;
  board: number;
  boardInner: number;
  paper: number;
  waiting: number;
  waitingText: string;
  sofa: number;
  sofaBack: number;
  coffee: number;
  chest: number;
  chestLid: number;
  chestLatch: number;
  label: string;
  labelBackground: string;
  status: { working: string; waiting: string; error: string; idle: string };
  plate: string;
  plateText?: string;
}
/** Local room coordinates; RoomView's container adds the campus offset once. */
export interface RoomPainter {
  rect(x: number, y: number, w: number, h: number, color: number): Phaser.GameObjects.Rectangle;
  text(x: number, y: number, text: string, size?: number, color?: string): Phaser.GameObjects.Text;
  circle(
    x: number,
    y: number,
    radius: number,
    color: number,
    alpha?: number,
  ): Phaser.GameObjects.Arc;
  polygon(x: number, y: number, points: number[], color: number): Phaser.GameObjects.Polygon;
  sprite(
    sheet: string,
    frame: number,
    x: number,
    y: number,
    scale?: number,
  ): Phaser.GameObjects.Image;
  zone(x: number, y: number, w: number, h: number): Phaser.GameObjects.Zone;
}
export interface OfficeTheme {
  id: OfficeThemeId;
  layout(seats: number): OfficeLayout;
  palette: OfficePalette;
  decorate(paint: RoomPainter, layout: OfficeLayout): void;
}
