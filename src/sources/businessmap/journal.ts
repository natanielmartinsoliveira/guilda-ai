import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import { BoardEvent } from '../../database/entities';
import type { BmCard } from './businessmap.client';
/**
 * The cards seen in another column, lane or owner than they were last seen in (all of them on
 * the first sighting, the journal's starting point), stored as board events.
 */
export async function recordMoves(
  db: DataSource,
  where: { tenantId: string; source: string },
  cards: BmCard[],
  at = new Date(),
) {
  const ids = [...new Set(cards.map((c) => c.card_id))];
  if (!ids.length) return 0;
  const known = await db
    .getRepository(BoardEvent)
    .find({ where: { ...where, cardId: In(ids) }, order: { at: 'ASC' } });
  const last = new Map(known.map((e) => [e.cardId, e]));
  const events = cards
    .filter((c) => {
      const l = last.get(c.card_id);
      return (
        !l ||
        l.columnId !== c.column_id ||
        (l.ownerId ?? null) !== (c.owner_user_id ?? null) ||
        (l.laneId ?? null) !== (c.lane_id ?? null)
      );
    })
    .map((c) => {
      const l = last.get(c.card_id);
      return {
        ...where,
        cardId: c.card_id,
        workflowId: c.workflow_id ?? 0,
        laneId: c.lane_id ?? null,
        columnId: c.column_id ?? 0,
        ownerId: c.owner_user_id ?? null,
        previousColumnId: l?.columnId ?? null,
        previousOwnerId: l ? (l.ownerId ?? null) : null,
        title: (c.title ?? '').slice(0, 300),
        at,
      };
    });
  if (events.length) await db.getRepository(BoardEvent).insert(events);
  return events.length;
}
/** What the journal shows over a period: the moves, how often each happened, and the time spent. */
export function summarize(events: BoardEvent[], columns: Map<number, string>) {
  const name = (id: number | null) => (id === null ? '?' : (columns.get(id) ?? String(id)));
  const moves = events.filter(
    (e) => e.previousColumnId !== null && e.previousColumnId !== e.columnId,
  );
  const transitions = new Map<string, number>();
  for (const m of moves) {
    const key = `${name(m.previousColumnId)} → ${name(m.columnId)}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  // Time in a column: from the event that put the card there to the one that took it out.
  const byCard = new Map<number, BoardEvent[]>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime()))
    byCard.set(e.cardId, [...(byCard.get(e.cardId) ?? []), e]);
  const stays = new Map<string, number[]>();
  for (const list of byCard.values())
    for (let i = 1; i < list.length; i++)
      if (list[i].columnId !== list[i - 1].columnId) {
        const where = name(list[i - 1].columnId);
        const hours = (list[i].at.getTime() - list[i - 1].at.getTime()) / 3600000;
        stays.set(where, [...(stays.get(where) ?? []), hours]);
      }
  return {
    moves: moves.length,
    cards: new Set(moves.map((m) => m.cardId)).size,
    transitions: [...transitions].sort((a, b) => b[1] - a[1]),
    hoursIn: [...stays]
      .map(([column, h]) => ({
        column,
        samples: h.length,
        median: [...h].sort((a, b) => a - b)[Math.floor(h.length / 2)],
      }))
      .sort((a, b) => b.median - a.median),
  };
}
