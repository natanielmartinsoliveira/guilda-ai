import { DataSource } from 'typeorm';
import { CardStarters, normalizeCardKey } from '../src/sources/card-starters';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { JiraClient, JiraIssue } from '../src/sources/jira/jira.client';
import { BusinessmapPoller } from '../src/sources/businessmap/businessmap.poller';
import { BmCard, BusinessmapClient } from '../src/sources/businessmap/businessmap.client';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import {
  BusinessmapSource,
  JiraSource,
  loadTenants,
  Tenant,
  useTenants,
} from '../src/tenants/tenants';
import { CODER_PROJECT, coderTenantYaml as yaml } from './fixtures/coder-tenant';
import { METHOD_PACK } from './fixtures/method-ws';
import { database } from './db';
import { Issue } from '../src/database/entities';

test('card keys are normalized per source format (Review Focus 3)', () => {
  expect(normalizeCardKey('jira', ' pf 12 ')).toBe('PF-12');
  expect(normalizeCardKey('jira', 'AB234')).toBeUndefined();
  expect(normalizeCardKey('number', ' #48816 ')).toBe('48816');
  expect(normalizeCardKey('number', '48 816')).toBe('48816');
  expect(normalizeCardKey('number', 'PF-1')).toBeUndefined();
});

test('the starters of a company: only sources that start cards, with their key format', () => {
  const starters = new CardStarters({} as JiraPoller, {} as BusinessmapPoller);
  const tenant = {
    sources: [
      { id: 'jira-a', type: 'jira' },
      { id: 'gh', type: 'github-issues' },
      { id: 'bm', type: 'businessmap' },
    ],
  } as unknown as Tenant;
  expect(starters.list(tenant)).toEqual([
    {
      id: 'jira-a',
      type: 'jira',
      label: 'Jira',
      key: 'jira',
      example: 'PF-123',
      bases: true,
      routes: false,
    },
    {
      id: 'bm',
      type: 'businessmap',
      label: 'Businessmap',
      key: 'number',
      example: '48816',
      bases: false,
      routes: true,
    },
  ]);
});

test('with two Jira sources, each start goes to the source asked for (Review Focus 1)', async () => {
  const used: string[] = [];
  class TestJira extends JiraPoller {
    protected client(source: JiraSource) {
      return {
        issue: async (key: string): Promise<JiraIssue> => {
          used.push(`${source.id}:${key}`);
          return { id: '1', key, fields: { summary: 'x', project: { key: 'PF' } } } as JiraIssue;
        },
      } as unknown as JiraClient;
    }
    async ingest() {
      return { skipped: 'ok' };
    }
  }
  const jira = new TestJira({} as DataSource, {} as OrchestratorService, {} as never);
  const tenant = { id: 'acme' } as Tenant;
  const a = { id: 'jira-a', type: 'jira', subtasks: 'same-pr' } as JiraSource;
  const b = { id: 'jira-b', type: 'jira', subtasks: 'same-pr' } as JiraSource;
  const starters = new CardStarters(jira, {} as BusinessmapPoller);
  await starters.for(b)!.start(tenant, b, 'PF-7');
  await starters.for(a)!.start(tenant, a, 'PF-8');
  expect(used).toEqual(['jira-b:PF-7', 'jira-a:PF-8']);
});

describe('Businessmap: start a card by its id', () => {
  let db: DataSource;
  let tenant: Tenant;
  let source: BusinessmapSource;
  beforeEach(async () => {
    db = await database();
    const list = loadTenants(
      yaml(
        `${CODER_PROJECT}\n        method: { name: review-gate }`,
        `    sources:
      - id: bm
        type: businessmap
        baseUrl: https://bm.test
        token: bm-test-token-0123456789
        boardId: 79
        trigger: { columns: [3170] }
        repositoryField: 13
    packDir: ${METHOD_PACK}`,
      ),
    );
    useTenants(list);
    tenant = list[0];
    source = tenant.sources[0] as BusinessmapSource;
  });
  afterEach(async () => {
    useTenants(undefined);
    await db.destroy();
  });
  const card: BmCard = {
    card_id: 48816,
    title: 'Fora do gatilho',
    description: '<p>x</p>',
    column_id: 2918,
    section: 4,
    tag_ids: [1],
    custom_fields: [{ field_id: 13, value: 'https://git.example.com/shop/shop-orders' }],
  };
  function poller(found: BmCard = card) {
    const client = {
      card: jest.fn(async () => found),
      tags: jest.fn(async () => new Map([[1, 'feature']])),
    };
    class TestPoller extends BusinessmapPoller {
      protected client() {
        return client as unknown as BusinessmapClient;
      }
    }
    return new TestPoller(db, new OrchestratorService(db, new TenantRegistry()));
  }
  test('a closed card outside the trigger is accepted when picked by hand (Review Focus 4); twice → the same task', async () => {
    const starters = new CardStarters({} as JiraPoller, poller());
    const first = await starters.for(source)!.start(tenant, source, '48816');
    expect(first).toEqual({ taskId: expect.any(String) });
    const again = await starters.for(source)!.start(tenant, source, '48816');
    expect(again).toEqual({
      skipped: 'Esse card já tem tarefa',
      taskId: (first as { taskId: string }).taskId,
    });
  });
  describe('the route chosen when starting by hand (no route tags on the board)', () => {
    const untagged = { ...card, tag_ids: [] };
    const issueRoute = async () =>
      (await db.getRepository(Issue).findOneByOrFail({ source: 'bm' })).meta?.route;
    test('a card without a route tag takes the chosen route', async () => {
      const bm = new CardStarters({} as JiraPoller, poller(untagged)).for(source)!;
      expect(bm.routes).toBe(true);
      expect(await bm.start(tenant, source, '48816', undefined, 'fix')).toEqual({
        taskId: expect.any(String),
      });
      expect(await issueRoute()).toBe('fix');
    });
    test('without a tag and without a choice, the card comes in with no route (the task asks)', async () => {
      const bm = new CardStarters({} as JiraPoller, poller(untagged)).for(source)!;
      expect(await bm.start(tenant, source, '48816')).toEqual({ taskId: expect.any(String) });
      expect(await issueRoute()).toBeUndefined();
    });
    test('a choice that contradicts the card tag is refused, naming both', async () => {
      const bm = new CardStarters({} as JiraPoller, poller()).for(source)!;
      const result = await bm.start(tenant, source, '48816', undefined, 'fix');
      expect(result).toEqual({ skipped: expect.stringMatching(/feature[\s\S]*fix/) });
    });
    test('the same route as the tag is fine', async () => {
      const bm = new CardStarters({} as JiraPoller, poller()).for(source)!;
      expect(await bm.start(tenant, source, '48816', undefined, 'feature')).toEqual({
        taskId: expect.any(String),
      });
    });
    test('a route the method does not have is refused', async () => {
      const bm = new CardStarters({} as JiraPoller, poller(untagged)).for(source)!;
      expect(await bm.start(tenant, source, '48816', undefined, 'hotfix')).toEqual({
        skipped: expect.stringMatching(/hotfix/),
      });
    });
  });
  test('Businessmap offers no sub-task bases', () => {
    expect(new CardStarters({} as JiraPoller, poller()).for(source)!.bases).toBeUndefined();
  });
});

test('two sources of the same type are told apart by their id (review finding 2)', () => {
  const starters = new CardStarters({} as JiraPoller, {} as BusinessmapPoller);
  const tenant = {
    sources: [
      { id: 'jira-pf', type: 'jira' },
      { id: 'jira-eng', type: 'jira' },
      { id: 'bm', type: 'businessmap' },
    ],
  } as unknown as Tenant;
  expect(starters.list(tenant).map((s) => s.label)).toEqual([
    'Jira (jira-pf)',
    'Jira (jira-eng)',
    'Businessmap',
  ]);
});

test('a Businessmap card of another board is not taken by this source (review finding 1)', async () => {
  const db = await database();
  const list = loadTenants(
    yaml(
      `${CODER_PROJECT}\n        method: { name: review-gate }`,
      `    sources:
      - id: bm
        type: businessmap
        baseUrl: https://bm.test
        token: bm-test-token-0123456789
        boardId: 79
        trigger: { columns: [3170] }
        repositoryField: 13
    packDir: ${METHOD_PACK}`,
    ),
  );
  useTenants(list);
  const client = {
    card: jest.fn(async () => ({ card_id: 5, board_id: 80, title: 'x', tag_ids: [1] })),
    tags: jest.fn(async () => new Map([[1, 'feature']])),
  };
  class TestPoller extends BusinessmapPoller {
    protected client() {
      return client as unknown as BusinessmapClient;
    }
  }
  const poller = new TestPoller(db, new OrchestratorService(db, new TenantRegistry()));
  const source = list[0].sources[0] as BusinessmapSource;
  expect(await poller.startById(list[0], source, 5)).toEqual({
    skipped: expect.stringMatching(/quadro/),
  });
  useTenants(undefined);
  await db.destroy();
});
