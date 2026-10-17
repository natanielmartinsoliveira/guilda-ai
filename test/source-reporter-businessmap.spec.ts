import { BusinessmapClient } from '../src/sources/businessmap/businessmap.client';
import { SourceEvent, SourceReporter } from '../src/sources/source-reporter.service';
import { BusinessmapSource, Tenant } from '../src/tenants/tenants';

const source = (moves: BusinessmapSource['moves']): BusinessmapSource => ({
  id: 'board',
  type: 'businessmap',
  baseUrl: 'https://bm.test',
  token: 'secret-key',
  boardId: 79,
  pollSeconds: 60,
  trigger: { columns: [10], owners: [] },
  moves,
  repositoryField: 13,
  routeTags: {},
});
function reporter(moves: BusinessmapSource['moves'], move = jest.fn(async () => {})) {
  const client = { move, comment: jest.fn() };
  class TestReporter extends SourceReporter {
    protected businessmap() {
      return client as unknown as BusinessmapClient;
    }
  }
  const tenant = { id: 'acme', sources: [source(moves)] } as unknown as Tenant;
  const report = (event: SourceEvent) =>
    new TestReporter().report(tenant, { source: 'board', externalKey: '49560' }, event);
  return { client, report };
}

test('each step moves the card to its column; nothing else is written', async () => {
  const x = reporter({ gate: 11, building: 12, built: 13, review: 14 });
  await x.report({ type: 'phase', board: 'gate' });
  await x.report({ type: 'phase', board: 'building' });
  await x.report({ type: 'built' });
  await x.report({ type: 'pr', prUrl: 'https://git/mr/1' });
  await x.report({ type: 'failed', error: 'boom' });
  expect(x.client.move.mock.calls).toEqual([
    [49560, 11],
    [49560, 12],
    [49560, 13],
    [49560, 14],
  ]);
  expect(x.client.comment).not.toHaveBeenCalled();
});

test('without moves the board is never called; a refused move does not throw', async () => {
  const none = reporter({});
  await none.report({ type: 'phase', board: 'gate' });
  await none.report({ type: 'pr', prUrl: 'https://git/mr/1' });
  expect(none.client.move).not.toHaveBeenCalled();
  const refused = reporter(
    { gate: 11 },
    jest.fn(async () => {
      throw new Error('Businessmap PATCH /cards/49560: HTTP 403');
    }),
  );
  await expect(refused.report({ type: 'phase', board: 'gate' })).resolves.toBeUndefined();
});
