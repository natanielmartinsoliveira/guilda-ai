import { ChangeFeed, OVERLAP_MS } from '../src/api/change-feed';
const at = (ms: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, 0) + ms);
test('a change seen again (overlap window, microsecond re-match) is sent once', () => {
  const feed = new ChangeFeed(at(0));
  const row = { type: 'task', id: 't1', updatedAt: at(10), status: 'RUNNING' };
  expect(feed.take([row])).toEqual([row]);
  // Next tick: the same row comes back (updatedAt > since matches it again in PostgreSQL).
  expect(feed.take([row])).toEqual([]);
  // A real new change of the same row is sent.
  const changed = { ...row, updatedAt: at(20), status: 'SUCCESS' };
  expect(feed.take([changed])).toEqual([changed]);
});
test('queries look back an overlap window, so late commits are not missed', () => {
  const feed = new ChangeFeed(at(1000));
  expect(feed.since().getTime()).toBe(at(1000).getTime() - OVERLAP_MS);
  feed.take([{ type: 'task', id: 't1', updatedAt: at(5000) }]);
  expect(feed.since().getTime()).toBe(at(5000).getTime() - OVERLAP_MS);
  // A row committed late with an older timestamp is still inside the window and is sent.
  const late = { type: 'decision', id: 'd1', updatedAt: at(4000) };
  expect(feed.take([late])).toEqual([late]);
});
test('memory stays bounded: entries older than the window are forgotten', () => {
  const feed = new ChangeFeed(at(0));
  feed.take([{ type: 'task', id: 'old', updatedAt: at(1) }]);
  feed.take([{ type: 'task', id: 'new', updatedAt: at(OVERLAP_MS * 3) }]);
  expect(feed.size()).toBe(1);
});
