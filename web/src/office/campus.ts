import type { Tenant, TaskView, DecisionView } from '../types';
import { officeModel, currentJob, ROLES, type OfficeModel, type GuildState } from './spots';
import { officeLayout, type Point } from './layout';
import { seatsFor } from './seats';
import { cameraFocus } from './camera';
export const COMPANY_COLORS = [
  '#b99ae4',
  '#a5d6b1',
  '#edc68a',
  '#8dcce5',
  '#e9a2bf',
  '#c2c985',
  '#e7b497',
  '#afb7ee',
];
export function companyCaption(name: string, running: number) {
  const characters = Array.from(name);
  return `${characters.length > 40 ? characters.slice(0, 39).join('').trimEnd() + '…' : name} ◆ ${running}`;
}
export interface RoomModel {
  tenantId: string;
  name: string;
  model: OfficeModel;
  seats: number;
  taskCount?: number;
  running?: number;
}
export interface CampusLayout {
  width: number;
  height: number;
  rooms: { tenantId: string; offset: Point; layout: ReturnType<typeof officeLayout> }[];
}
export function campusModel(
  tenants: Tenant[],
  tasks: TaskView[],
  decisions: DecisionView[],
): RoomModel[] {
  return tenants.map((tenant) => {
    const own = tasks.filter((t) => t.tenantId === tenant.id);
    const model = officeModel(
      own,
      decisions.filter((d) => d.tenantId === tenant.id),
    );
    const seats = seatsFor(tenant.concurrency ?? 1, model.crew);
    return {
      tenantId: tenant.id,
      name: tenant.name,
      seats,
      model: { ...model, roomKey: tenant.id, tenantId: tenant.id, seats },
      taskCount: own.length,
      running: own.filter((t) => currentJob(t).status === 'RUNNING').length,
    };
  });
}
export function campusLayout(rooms: { tenantId: string; seats: number }[]): CampusLayout {
  const placed: CampusLayout['rooms'] = [];
  let y = rooms.length > 1 ? 96 : 0,
    width = 0;
  for (let row = 0; row < rooms.length; row += 3) {
    let x = 0,
      height = 0;
    for (const room of rooms.slice(row, row + 3)) {
      const layout = officeLayout(room.seats);
      placed.push({ tenantId: room.tenantId, offset: { x, y }, layout });
      x += layout.width + 96;
      height = Math.max(height, layout.height);
    }
    width = Math.max(width, x - 96);
    y += height + (row + 3 < rooms.length ? 96 : 0);
  }
  return { width: width || 960, height: y || 640, rooms: placed };
}
export interface CampusActor extends Point {
  tenantId: string;
  moving: boolean;
  working: boolean;
}
export function campusFocusPoints(
  rooms: CampusLayout['rooms'],
  actors: CampusActor[],
  overview = false,
): Point[] {
  if (overview) return [];
  const walking = actors.filter((a) => a.moving);
  const targets = walking.length ? walking : actors.filter((a) => a.working);
  return targets.flatMap((actor) => {
    const room = rooms.find((r) => r.tenantId === actor.tenantId);
    return room ? [{ x: room.offset.x + actor.x, y: room.offset.y + actor.y }] : [];
  });
}
export function roomCameraFocus(
  room: CampusLayout['rooms'][number],
  view: { width: number; height: number },
  world: { width: number; height: number },
) {
  const zoom = cameraFocus([], view, room.layout).zoom;
  return cameraFocus(
    [{ x: room.offset.x + room.layout.width / 2, y: room.offset.y + room.layout.height / 2 }],
    view,
    world,
    { padding: 0, minZoom: zoom, maxZoom: zoom },
  );
}
export function campusCameraFocus(
  rooms: RoomModel[],
  layout: CampusLayout,
  actors: CampusActor[],
  view: { width: number; height: number },
  overview = false,
) {
  const points = campusFocusPoints(layout.rooms, actors, overview);
  if (!overview && !points.length && view.width < 600) {
    const first = rooms.find((r) => (r.taskCount ?? r.model.crew.length) > 0);
    const room = layout.rooms.find((r) => r.tenantId === first?.tenantId);
    if (room) return roomCameraFocus(room, view, layout);
  }
  return cameraFocus(points, view, layout);
}
export function campusGuild(rooms: RoomModel[]): GuildState {
  const urgency = { error: 0, waiting: 1, working: 2, idle: 3 };
  const states = rooms.map((r) => r.model.guild!);
  return {
    agents: ROLES.map((role) => {
      const agents = states.flatMap((s) => s.agents.filter((a) => a.role === role));
      const first = [...agents].sort((a, b) => urgency[a.tone] - urgency[b.tone])[0];
      const fallback = officeModel([], []).guild!.agents.find((a) => a.role === role)!;
      return { ...(first ?? fallback), tasks: agents.flatMap((a) => a.tasks) };
    }),
    active: states.reduce((n, s) => n + s.active, 0),
    queued: states.reduce((n, s) => n + s.queued, 0),
    waiting: states.reduce((n, s) => n + s.waiting, 0),
    completed: states.flatMap((s) => s.completed),
  };
}
