import { ROLES, type CrewMember, type GuildRole } from './spots';
export const MAX_SEATS = 4;
export type Seat = { role: GuildRole; seat: number };
export function seatsFor(concurrency: number, members: CrewMember[], previous = 1) {
  return Math.min(
    MAX_SEATS,
    Math.max(
      1,
      Math.floor(concurrency || 1),
      previous,
      ...ROLES.map((role) => members.filter((m) => m.role === role).length),
    ),
  );
}
const PRIORITY = { working: 0, waiting: 1, error: 2 };
export function assignSeats(members: CrewMember[], previous: Map<string, Seat>, seats: number) {
  const placed = new Map<string, Seat>();
  const overflow: Partial<Record<GuildRole, number>> = {};
  for (const role of ROLES) {
    const here = members
      .filter((m) => m.role === role)
      .sort(
        (a, b) =>
          PRIORITY[a.tone] - PRIORITY[b.tone] ||
          (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
          a.id.localeCompare(b.id),
      );
    const selected = here.slice(0, seats);
    if (here.length > seats) overflow[role] = here.length - seats;
    const used = new Set<number>();
    for (const m of selected) {
      const old = previous.get(m.id);
      if (old?.role === role && old.seat < seats && !used.has(old.seat)) {
        placed.set(m.id, old);
        used.add(old.seat);
      }
    }
    for (const m of selected)
      if (!placed.has(m.id)) {
        let seat = 0;
        while (used.has(seat)) seat++;
        placed.set(m.id, { role, seat });
        used.add(seat);
      }
  }
  return { placed, overflow };
}
