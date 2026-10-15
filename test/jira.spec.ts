import { DataSource } from 'typeorm';
import { readFile, rm } from 'node:fs/promises';
import { adfToText } from '../src/sources/jira/adf';
import { JiraClient, JiraIssue } from '../src/sources/jira/jira.client';
import { JiraPoller } from '../src/sources/jira/jira.poller';
import { SourceReporter } from '../src/sources/source-reporter.service';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { findTenant, JiraSource, loadTenants } from '../src/tenants/tenants';
import { attachmentsDir } from '../src/attachments/attachments';
import { Issue, Task } from '../src/database/entities';
import { database } from './db';
const acme = () => findTenant('acme')!;
const cloud = () => acme().sources.find((s) => s.id === 'jira') as JiraSource;
const datacenter = (): JiraSource => ({
  ...cloud(),
  deployment: 'datacenter',
  baseUrl: 'https://jira.corp.example',
  email: undefined,
});
function fakeFetch(responses: Record<string, unknown> = {}) {
  return jest.fn(async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    const body = responses[key];
    return new Response(body === undefined ? '' : JSON.stringify(body), { status: 200 });
  });
}
describe('ADF', () => {
  test('renders Jira Cloud rich text as readable text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Contexto' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Veja ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://x.test' } }],
            },
            { type: 'text', text: ' e ' },
            { type: 'text', text: 'login()', marks: [{ type: 'code' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'um' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dois' }] }],
            },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x()' }] },
        { type: 'mysteryNode', content: [{ type: 'text', text: 'kept' }] },
      ],
    };
    expect(adfToText(doc)).toBe(
      '## Contexto\n\nVeja [docs](https://x.test) e `login()`\n\n- um\n- dois\n\n```ts\nx()\n```\n\nkept',
    );
    expect(adfToText(null)).toBe('');
    expect(adfToText('wiki *markup*')).toBe('wiki *markup*');
  });
});
describe('JiraClient', () => {
  test('Cloud uses enhanced JQL search, e-mail+token basic auth and ADF comments', async () => {
    const http = fakeFetch({
      'GET /rest/api/3/search/jql': { issues: [{ id: '1', key: 'DEMO-1', fields: {} }] },
    });
    const client = new JiraClient(cloud(), http as any);
    expect(await client.search()).toHaveLength(1);
    const [url, init] = http.mock.calls[0];
    expect(String(url)).toContain('https://acme.atlassian.net/rest/api/3/search/jql?jql=labels');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('bot@acme.test:test-acme-jira-token').toString('base64')}`,
    );
    await client.comment('DEMO-1', 'a\n\nb');
    expect(JSON.parse(String(http.mock.calls[1][1]!.body)).body).toMatchObject({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'paragraph' }],
    });
  });
  test('Data Center uses REST v2, bearer PAT and plain comments', async () => {
    const http = fakeFetch({ 'GET /rest/api/2/search': { issues: [] } });
    const client = new JiraClient(datacenter(), http as any);
    await client.search();
    expect(String(http.mock.calls[0][0])).toContain('https://jira.corp.example/rest/api/2/search?');
    expect((http.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-acme-jira-token',
    );
    await client.comment('DEMO-1', 'hello');
    expect(JSON.parse(String(http.mock.calls[1][1]!.body))).toEqual({ body: 'hello' });
  });
  test('transitions by transition or target status name, reports when unavailable', async () => {
    const http = fakeFetch({
      'GET /rest/api/3/issue/DEMO-1/transitions': {
        transitions: [{ id: '31', name: 'Start work', to: { name: 'In Progress' } }],
      },
    });
    const client = new JiraClient(cloud(), http as any);
    expect(await client.transition('DEMO-1', 'in progress')).toBe(true);
    expect(JSON.parse(String(http.mock.calls[1][1]!.body))).toEqual({ transition: { id: '31' } });
    expect(await client.transition('DEMO-1', 'Done')).toBe(false);
  });
  test('an exact transition name wins over a near-duplicate with other casing', async () => {
    const http = fakeFetch({
      'GET /rest/api/3/issue/PF-1/transitions': {
        transitions: [
          { id: '21', name: 'Em andamento', to: { name: 'Em andamento' } },
          { id: '41', name: 'EM ANDAMENTO', to: { name: 'EM ANDAMENTO' } },
        ],
      },
    });
    const client = new JiraClient(cloud(), http as any);
    expect(await client.transition('PF-1', 'EM ANDAMENTO')).toBe(true);
    expect(JSON.parse(String(http.mock.calls[1][1]!.body))).toEqual({ transition: { id: '41' } });
    expect(await client.transition('PF-1', 'em ANDAMENTO')).toBe(true);
    expect(JSON.parse(String(http.mock.calls[3][1]!.body))).toEqual({ transition: { id: '21' } });
  });
  test('never sends Jira credentials to another origin, and enforces the size limit', async () => {
    const http = fakeFetch();
    const client = new JiraClient(cloud(), http as any);
    await expect(
      client.download({ id: '1', filename: 'x', content: 'https://evil.test/file' }, 1000),
    ).rejects.toThrow('outside Jira origin');
    await expect(
      client.download(
        { id: '1', filename: 'big', size: 5000, content: 'https://acme.atlassian.net/secure/1' },
        1000,
      ),
    ).rejects.toThrow('above 1000 bytes');
    expect(http).not.toHaveBeenCalled();
  });
  test('configuration requires https and, on Cloud, the account e-mail', () => {
    const base = (source: string) => `
tenants:
  - id: t
    name: T
    git: { authorName: B, authorEmail: b@t.test }
    ai: { providers: [codex], credentials: [{ id: c, provider: codex }] }
    hosts: [{ id: gh, type: github, token: x }]
    sources: [${source}]
    projects: [{ id: api, host: gh, repository: t/api, test: [npm, test] }]
`;
    expect(() =>
      loadTenants(
        base('{ id: j, type: jira, baseUrl: "http://j.test", email: a@b.c, token: x, jql: x }'),
        {},
      ),
    ).toThrow('must use https');
    expect(() =>
      loadTenants(base('{ id: j, type: jira, baseUrl: "https://j.test", token: x, jql: x }'), {}),
    ).toThrow('requires email');
    expect(() =>
      loadTenants(
        base(
          '{ id: j, type: jira, baseUrl: "https://j.test", deployment: datacenter, token: x, jql: x, defaultProject: nope }',
        ),
        {},
      ),
    ).toThrow('maps to unknown project "nope"');
  });
});
describe('JiraPoller', () => {
  let db: DataSource;
  beforeEach(async () => {
    db = await database();
  });
  afterEach(async () => {
    await db.destroy();
    await rm(process.env.ATTACHMENTS_ROOT!, { recursive: true, force: true });
  });
  const issue = (over: Partial<JiraIssue['fields']> = {}, key = 'DEMO-12'): JiraIssue => ({
    id: '10012',
    key,
    fields: {
      summary: 'Botão de login quebrado',
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No mobile.' }] }],
      },
      project: { key: key.split('-')[0] },
      attachment: [
        {
          id: 'a1',
          filename: 'print.png',
          mimeType: 'image/png',
          size: 3,
          content: 'https://acme.atlassian.net/a1',
        },
        { id: 'a2', filename: 'huge.zip', size: 9e9, content: 'https://acme.atlassian.net/a2' },
      ],
      ...over,
    },
  });
  function setup(issues: JiraIssue[]) {
    const client = {
      search: jest.fn().mockResolvedValue(issues),
      download: jest.fn(async (a: { filename: string; size?: number }) => {
        if ((a.size ?? 0) > 2048) throw new Error(`Attachment ${a.filename} above 2048 bytes`);
        return Buffer.from('png');
      }),
    };
    const reporter = { report: jest.fn() };
    class TestPoller extends JiraPoller {
      protected client() {
        return client as unknown as JiraClient;
      }
    }
    const poller = new TestPoller(
      db,
      new OrchestratorService(db, new TenantRegistry()),
      reporter as any,
    );
    return { client, reporter, poller };
  }
  test('turns a matching card into a task with its attachments, once', async () => {
    const x = setup([issue()]);
    await x.poller.poll(acme(), cloud());
    const stored = await db.getRepository(Issue).findOneByOrFail({ source: 'jira' });
    expect(stored).toMatchObject({
      tenantId: 'acme',
      externalId: '10012',
      externalKey: 'DEMO-12',
      title: 'Botão de login quebrado',
      url: 'https://acme.atlassian.net/browse/DEMO-12',
      closingRef: null,
    });
    expect(stored.body).toBe(
      'No mobile.\n\nAnexo huge.zip ignorado: Attachment huge.zip above 2048 bytes.',
    );
    expect(stored.attachments).toEqual([{ name: 'print.png', contentType: 'image/png', size: 3 }]);
    expect(await readFile(`${attachmentsDir('acme', 'jira', '10012')}/print.png`, 'utf8')).toBe(
      'png',
    );
    const task = await db.getRepository(Task).findOneByOrFail({ issueId: stored.id });
    expect(x.reporter.report).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acme' }),
      { source: 'jira', externalKey: 'DEMO-12' },
      { type: 'accepted', taskId: task.id, steps: [] },
    );
    // The card is still in the JQL on the next poll: no new task, no new download.
    x.client.download.mockClear();
    await x.poller.poll(acme(), cloud());
    expect(await db.getRepository(Task).count()).toBe(1);
    expect(x.client.download).not.toHaveBeenCalled();
  });
  test('cards of unmapped Jira projects are skipped', async () => {
    const x = setup([{ ...issue({}, 'OTHER-1'), id: '99' }]);
    await x.poller.poll(acme(), cloud());
    expect(await db.getRepository(Task).count()).toBe(0);
    expect(x.client.download).not.toHaveBeenCalled();
  });
  test('one bad card does not block the others; a search failure does not throw', async () => {
    const x = setup([
      { ...issue(), id: 'not-numeric' },
      { ...issue({}, 'DEMO-13'), id: '10013' },
    ]);
    await x.poller.poll(acme(), cloud());
    expect(await db.getRepository(Task).count()).toBe(1);
    x.client.search.mockRejectedValue(new Error('Jira down'));
    await expect(x.poller.poll(acme(), cloud())).resolves.toBeUndefined();
  });
});
describe('SourceReporter', () => {
  function setup(source = cloud()) {
    const jira = { comment: jest.fn(), transition: jest.fn().mockResolvedValue(true) };
    class TestReporter extends SourceReporter {
      protected jira() {
        return jira as unknown as JiraClient;
      }
    }
    const tenant = { ...acme(), sources: [source] };
    return { jira, tenant, reporter: new TestReporter() };
  }
  const item = { source: 'jira', externalKey: 'DEMO-12' };
  test('moves and comments the card along the task lifecycle', async () => {
    const x = setup();
    await x.reporter.report(x.tenant, item, { type: 'accepted', taskId: 't1' });
    expect(x.jira.transition).toHaveBeenCalledWith('DEMO-12', 'In Progress');
    expect(x.jira.comment.mock.calls[0][1]).toContain('task t1');
    await x.reporter.report(x.tenant, item, { type: 'pr', prUrl: 'https://github.com/p/1' });
    expect(x.jira.comment.mock.calls[1][1]).toContain('https://github.com/p/1');
    expect(x.jira.transition).toHaveBeenLastCalledWith('DEMO-12', 'In Review');
    await x.reporter.report(x.tenant, item, {
      type: 'failed',
      error: 'TESTS: failed with test-acme-jira-token',
    });
    expect(x.jira.comment.mock.calls[2][1]).toContain('[REDACTED]');
  });
  test('tracker errors are swallowed; comments can be disabled', async () => {
    const x = setup({ ...cloud(), comments: false });
    x.jira.transition.mockRejectedValue(new Error('Jira 500'));
    await expect(
      x.reporter.report(x.tenant, item, { type: 'accepted', taskId: 't1' }),
    ).resolves.toBeUndefined();
    expect(x.jira.comment).not.toHaveBeenCalled();
  });
  test('sources without feedback support are a no-op', async () => {
    const x = setup();
    await x.reporter.report(
      x.tenant,
      { source: 'api', externalKey: 'T-1' },
      { type: 'pr', prUrl: 'u' },
    );
    expect(x.jira.comment).not.toHaveBeenCalled();
  });
});
