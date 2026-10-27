import { DataSource } from 'typeorm';
import { BmCard, BusinessmapClient } from '../src/sources/businessmap/businessmap.client';
import { BusinessmapPoller } from '../src/sources/businessmap/businessmap.poller';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { BusinessmapSource, loadTenants, Tenant, useTenants } from '../src/tenants/tenants';
import { Issue, Task } from '../src/database/entities';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';
import { database } from './db';
import { METHOD_PACK } from './fixtures/method-ws';

const BASE_SOURCE = `    sources:
      - id: businessmap
        type: businessmap
        baseUrl: https://bm.test
        token: bm-test-token-0123456789
        boardId: 79
        trigger: { columns: [3170], tag: ai-dev-team }
        repositoryField: 13`;
const SOURCE = `${BASE_SOURCE}\n        routeTags: { regra: feature, tela: screen }`;
const WITH_METHOD = `${CODER_PROJECT}\n        method: { name: review-gate }`;
const REPO = 'https://git.example.com/shop/shop-orders';

const card = (id: number, extra: Partial<BmCard> = {}): BmCard => ({
  card_id: id,
  title: `Card ${id}`,
  description: '<p>Faça <b>X</b></p>',
  column_id: 3170,
  section: 3,
  tag_ids: [1],
  custom_fields: [{ field_id: 13, value: REPO }],
  linked_cards: [
    { card_id: 900, link_type: 'parent' },
    { card_id: 901, link_type: 'relative' },
  ],
  ...extra,
});

describe('BusinessmapPoller', () => {
  let db: DataSource;
  let tenant: Tenant;
  let source: BusinessmapSource;
  const load = (project: string, sources = SOURCE) => {
    const list = loadTenants(yaml(project, `${sources}\n    packDir: ${METHOD_PACK}`));
    useTenants(list);
    tenant = list[0];
    source = tenant.sources[0] as BusinessmapSource;
  };
  beforeEach(async () => {
    db = await database();
    load(WITH_METHOD);
  });
  afterEach(async () => {
    useTenants(undefined);
    await db.destroy();
  });
  function setup(cards: Record<number, BmCard>) {
    const related: Record<number, BmCard> = {
      900: { card_id: 900, title: 'Venda com oferta' },
      901: { card_id: 901, title: 'Contrato' },
    };
    const client = {
      candidates: jest.fn(async (): Promise<BmCard[]> =>
        Object.values(cards).map((c) => ({ card_id: c.card_id, section: 3 })),
      ),
      card: jest.fn(async (id: number) => cards[id] ?? related[id]),
      tags: jest.fn(
        async () =>
          new Map([
            [1, 'Regra'],
            [2, 'tela'],
            [3, 'ai-dev-team'],
            [4, 'Melhoria'],
          ]),
      ),
    };
    const orchestrator = new OrchestratorService(db, new TenantRegistry());
    const accept = jest.spyOn(orchestrator, 'accept');
    class TestPoller extends BusinessmapPoller {
      protected client() {
        return client as unknown as BusinessmapClient;
      }
    }
    return { client, accept, poller: new TestPoller(db, orchestrator) };
  }

  test('a card with a route tag and a repository link becomes a task of the method, once', async () => {
    const x = setup({ 101: card(101) });
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    expect(x.accept.mock.calls[0][1]).toMatchObject({
      source: 'businessmap',
      externalId: '101',
      key: '101',
      title: 'Card 101',
      project: 'svc',
      url: 'https://bm.test/ctrl_board/79/cards/101/details/',
      delivery: { route: 'feature' },
    });
    const stored = await db.getRepository(Issue).findOneByOrFail({ source: 'businessmap' });
    expect(stored.body).toBe(
      'Faça X\n\nCard pai: Venda com oferta (900)\nCard relacionado: Contrato (901)',
    );
    expect(stored.meta?.route).toBe('feature');
    // Still in the column on the next poll: no second task.
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    const again = await x.poller.ingest(tenant, source, x.client as any, card(101), new Map());
    const task = await db.getRepository(Task).findOneByOrFail({ issueId: stored.id });
    expect(again).toEqual({ skipped: 'Esse card já tem tarefa', taskId: task.id });
  });

  test('the operator restarts a card whose task published nothing; a poll never does', async () => {
    const x = setup({ 101: card(101) });
    await x.poller.poll(tenant, source);
    const stored = await db.getRepository(Issue).findOneByOrFail({ source: 'businessmap' });
    const first = await db.getRepository(Task).findOneByOrFail({ issueId: stored.id });
    await db.getRepository(Task).update(first.id, { status: 'SUCCESS' } as never);
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    const restarted = await x.poller.startById(tenant, source, 101, undefined, true);
    expect(x.accept).toHaveBeenCalledTimes(2);
    expect(x.accept.mock.calls[1][2]).toEqual({ again: true });
    expect(restarted.taskId).not.toBe(first.id);
    // the card's task is now the new one, for polls too
    expect(await x.poller.ingest(tenant, source, x.client as any, card(101), new Map())).toEqual({
      skipped: 'Esse card já tem tarefa',
      taskId: restarted.taskId,
    });
  });

  test('without the repository field, or with an unknown repository, the card waits until fixed', async () => {
    const cards = { 102: card(102, { custom_fields: [] }) };
    const x = setup(cards);
    const tags = await x.client.tags();
    expect(await x.poller.ingest(tenant, source, x.client as any, card(102), tags)).toEqual({
      skipped: expect.stringMatching(/campo de repositório/),
    });
    cards[102] = card(102, {
      custom_fields: [{ field_id: 13, value: 'https://git.example.com/shop/outro' }],
    });
    expect(await x.poller.ingest(tenant, source, x.client as any, card(102), tags)).toEqual({
      skipped: expect.stringContaining('shop/outro'),
    });
    cards[102] = card(102);
    expect(await x.poller.ingest(tenant, source, x.client as any, card(102), tags)).toEqual({
      taskId: expect.any(String),
    });
  });

  test('a card of a method without a route tag is taken without a route (the task asks which)', async () => {
    const x = setup({});
    const tags = await x.client.tags();
    x.client.card.mockResolvedValueOnce(card(103, { tag_ids: [3, 4] }));
    expect(await x.poller.ingest(tenant, source, x.client as any, card(103), tags)).toEqual(
      expect.objectContaining({ taskId: expect.any(String) }),
    );
    expect(x.accept.mock.calls[0][1]).not.toHaveProperty('delivery');
  });

  test('only cards of the trigger owners are taken from the poll', async () => {
    load(WITH_METHOD, SOURCE.replace('tag: ai-dev-team }', 'tag: ai-dev-team, owners: [7] }'));
    const x = setup({ 104: card(104), 105: card(105) });
    x.client.candidates.mockResolvedValueOnce([
      { card_id: 104, section: 3, owner_user_id: 8 },
      { card_id: 105, section: 3, owner_user_id: 7 },
    ]);
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    expect(x.accept.mock.calls[0][1]).toMatchObject({ externalId: '105' });
  });

  test('a card of a method takes at most one route tag', async () => {
    const x = setup({});
    const tags = await x.client.tags();
    x.client.card.mockResolvedValueOnce(card(103, { tag_ids: [1, 2] }));
    expect(await x.poller.ingest(tenant, source, x.client as any, card(103), tags)).toEqual({
      skipped: expect.stringMatching(/mais de uma rota/),
    });
    expect(x.accept).not.toHaveBeenCalled();
  });

  test('without routeTags, a tag named as a route is that route (names of object internals are not)', async () => {
    load(WITH_METHOD, BASE_SOURCE);
    const x = setup({});
    const tags = new Map([
      [1, 'Feature'],
      [2, 'constructor'],
    ]);
    // "constructor" is no route: the card is taken without one.
    x.client.card.mockResolvedValueOnce(card(107, { tag_ids: [2] }));
    await x.poller.ingest(tenant, source, x.client as any, card(107), tags);
    expect(x.accept.mock.calls[0][1]).not.toHaveProperty('delivery');
    x.client.card.mockResolvedValueOnce(card(108, { tag_ids: [1, 2] }));
    expect(await x.poller.ingest(tenant, source, x.client as any, card(108), tags)).toEqual({
      taskId: expect.any(String),
    });
    expect(x.accept.mock.calls[1][1].delivery).toEqual({ route: 'feature' });
  });

  test('with routeTags configured, only the mapped tags are routes (review M1)', async () => {
    const x = setup({});
    // "Regra" is mapped to feature; "screen" is an ordinary board tag here, not a second route.
    const tags = new Map([
      [1, 'Regra'],
      [2, 'screen'],
    ]);
    x.client.card.mockResolvedValueOnce(card(109, { tag_ids: [1, 2] }));
    expect(await x.poller.ingest(tenant, source, x.client as any, card(109), tags)).toEqual({
      taskId: expect.any(String),
    });
    expect(x.accept.mock.calls[0][1].delivery).toEqual({ route: 'feature' });
  });

  test('a project without a method ignores route tags', async () => {
    load(CODER_PROJECT);
    const x = setup({ 104: card(104, { tag_ids: [1, 2] }) });
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    expect(x.accept.mock.calls[0][1].delivery).toBeUndefined();
  });

  test('a waiting card is logged once per reason, not on every poll', async () => {
    const x = setup({ 107: card(107, { custom_fields: [] }) });
    const out = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await x.poller.poll(tenant, source);
      await x.poller.poll(tenant, source);
      const skipped = out.mock.calls.filter(([line]) =>
        String(line).includes('"businessmap.skipped"'),
      );
      expect(skipped).toHaveLength(1);
      expect(String(skipped[0][0])).toContain('campo de repositório');
    } finally {
      out.mockRestore();
    }
  });

  test('a failing card does not stop the others; a failing board does not throw', async () => {
    const x = setup({ 105: card(105), 106: card(106) });
    x.client.card.mockImplementationOnce(async () => {
      throw new Error('HTTP 500');
    });
    await x.poller.poll(tenant, source);
    expect(x.accept).toHaveBeenCalledTimes(1);
    expect(x.accept.mock.calls[0][1].externalId).toBe('106');
    x.client.candidates.mockRejectedValueOnce(new Error('HTTP 401'));
    await expect(x.poller.poll(tenant, source)).resolves.toBeUndefined();
  });
});

test("a route tag pointing at a route the project's method does not have is refused (Review Focus 2)", async () => {
  const db = await database();
  const list = loadTenants(
    yaml(
      WITH_METHOD,
      `${BASE_SOURCE}\n        routeTags: { regra: hotfix }\n    packDir: ${METHOD_PACK}`,
    ),
  );
  useTenants(list);
  const tenant = list[0];
  const source = tenant.sources[0] as BusinessmapSource;
  const client = {
    card: jest.fn(async () => card(301)),
    tags: jest.fn(async () => new Map([[1, 'regra']])),
  };
  const poller = new BusinessmapPoller(db, new OrchestratorService(db, new TenantRegistry()));
  const result = await poller.ingest(
    tenant,
    source,
    client as never,
    card(301),
    await client.tags(),
  );
  expect(result).toEqual({ skipped: expect.stringMatching(/hotfix/) });
  useTenants(undefined);
  await db.destroy();
});
