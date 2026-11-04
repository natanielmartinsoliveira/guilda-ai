import { DataSource } from 'typeorm';
import { BoardEvent } from '../src/database/entities';
import { recordMoves, summarize } from '../src/sources/businessmap/journal';
import { BmCard, BusinessmapClient } from '../src/sources/businessmap/businessmap.client';
import { BusinessmapPoller } from '../src/sources/businessmap/businessmap.poller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { BusinessmapSource, Tenant } from '../src/tenants/tenants';
import { database } from './db';

let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const where = { tenantId: 'acme', source: 'falcon' };
const card = (id: number, column: number, owner?: number): BmCard => ({
  card_id: id,
  workflow_id: 311,
  lane_id: 538,
  column_id: column,
  owner_user_id: owner,
  title: `Card ${id}`,
});
const events = () => db.getRepository(BoardEvent).find({ order: { at: 'ASC', cardId: 'ASC' } });

test('the first pass is the starting point; then only what moved, with where it came from', async () => {
  const t0 = new Date('2026-11-05T09:00:00Z');
  expect(await recordMoves(db, where, [card(1, 2904), card(2, 2905, 86)], t0)).toBe(2);
  const t1 = new Date('2026-11-05T10:30:00Z');
  // 1 moved to To Do, 2 changed owner, 3 is new; 1 is read twice in the same pass window
  expect(await recordMoves(db, where, [card(1, 2905), card(2, 2905, 291), card(3, 2900)], t1)).toBe(
    3,
  );
  expect(await recordMoves(db, where, [card(1, 2905), card(2, 2905, 291)], t1)).toBe(0);
  const all = await events();
  expect(
    all.map((e) => [e.cardId, e.previousColumnId, e.columnId, e.previousOwnerId, e.ownerId]),
  ).toEqual([
    [1, null, 2904, null, null],
    [2, null, 2905, null, 86],
    [1, 2904, 2905, null, null],
    [2, 2905, 2905, 86, 291],
    [3, null, 2900, null, null],
  ]);
});

test('the summary: how often each move happened and how long cards stayed in a column', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h));
  const e = (cardId: number, prev: number | null, col: number, h: number) =>
    ({ cardId, previousColumnId: prev, columnId: col, at: at(h) }) as BoardEvent;
  const s = summarize(
    [
      e(1, null, 2905, 8),
      e(1, 2905, 2907, 9),
      e(1, 2907, 2908, 13),
      e(2, null, 2905, 8),
      e(2, 2905, 2907, 11),
    ],
    new Map([
      [2905, 'To Do'],
      [2907, 'Em andamento'],
      [2908, 'Pronto'],
    ]),
  );
  expect(s.moves).toBe(3);
  expect(s.cards).toBe(2);
  expect(s.transitions).toEqual([
    ['To Do → Em andamento', 2],
    ['Em andamento → Pronto', 1],
  ]);
  expect(s.hoursIn).toEqual([
    { column: 'Em andamento', samples: 1, median: 4 },
    { column: 'To Do', samples: 2, median: 3 },
  ]);
});

test('the poller keeps the journal of the configured workflows, asking only for what changed', async () => {
  const inWorkflows = jest.fn(async (_w: number[], _since?: Date) => [card(1, 2905)]);
  const client = { candidates: jest.fn(async () => []), inWorkflows };
  class TestPoller extends BusinessmapPoller {
    protected client() {
      return client as unknown as BusinessmapClient;
    }
  }
  const source = {
    id: 'falcon',
    type: 'businessmap',
    trigger: { columns: [2907], owners: [] },
    journal: { workflows: [311] },
  } as unknown as BusinessmapSource;
  const tenant = { id: 'acme' } as Tenant;
  const poller = new TestPoller(db, new OrchestratorService(db, new TenantRegistry()));
  await poller.poll(tenant, source);
  await poller.poll(tenant, source);
  expect(inWorkflows.mock.calls[0]).toEqual([[311], undefined]);
  expect(inWorkflows.mock.calls[1][1]).toBeInstanceOf(Date);
  expect(await events()).toHaveLength(1);
});
