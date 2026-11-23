import { BusinessmapGate, GateClock, gateFor } from '../src/sources/businessmap/businessmap.gate';

/** A clock that only moves when the gate sleeps, recording every sleep. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  const clock: GateClock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps, advance: (ms: number) => (now += ms) };
}

function reply(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

const budget = (minute: number, hour: number) => ({
  'x-ratelimit-perminute-remaining': String(minute),
  'x-ratelimit-perhour-remaining': String(hour),
});

test('one request at a time: the second starts only after the first answered', async () => {
  const gate = new BusinessmapGate(fakeClock().clock);
  const order: string[] = [];
  let release!: () => void;
  const first = gate.send(async () => {
    order.push('first:start');
    await new Promise<void>((r) => (release = r));
    order.push('first:end');
    return reply(200);
  });
  const second = gate.send(async () => {
    order.push('second:start');
    return reply(200);
  });
  await new Promise((r) => setImmediate(r));
  expect(order).toEqual(['first:start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first:start', 'first:end', 'second:start']);
});

test('a failed request does not stop the queue', async () => {
  const gate = new BusinessmapGate(fakeClock().clock);
  await expect(gate.send(async () => Promise.reject(new Error('offline')))).rejects.toThrow(
    'offline',
  );
  expect((await gate.send(async () => reply(200))).status).toBe(200);
});

test("with the minute's budget gone, the next request waits a minute first", async () => {
  const { clock, sleeps } = fakeClock();
  const gate = new BusinessmapGate(clock);
  await gate.send(async () => reply(200, budget(1, 400)));
  expect(sleeps).toEqual([]);
  await gate.send(async () => reply(200, budget(29, 399)));
  expect(sleeps).toEqual([60_000]);
  await gate.send(async () => reply(200, budget(28, 398)));
  expect(sleeps).toEqual([60_000]);
});

test('a 429 waits what the board asks (body or Retry-After) and tries once more', async () => {
  const { clock, sleeps } = fakeClock();
  const gate = new BusinessmapGate(clock);
  const limited = { error: { code: 'RL01', details: { limit: 30, retry_after: 12 } } };
  const perform = jest
    .fn<Promise<Response>, []>()
    .mockResolvedValueOnce(reply(429, {}, limited))
    .mockResolvedValueOnce(reply(200, budget(29, 500)));
  expect((await gate.send(perform)).status).toBe(200);
  expect(perform).toHaveBeenCalledTimes(2);
  expect(sleeps).toEqual([12_000]);

  const header = jest
    .fn<Promise<Response>, []>()
    .mockResolvedValueOnce(reply(429, { 'retry-after': '5' }))
    .mockResolvedValueOnce(reply(429, { 'retry-after': '5' }));
  expect((await gate.send(header)).status).toBe(429);
  expect(header).toHaveBeenCalledTimes(2);
  expect(sleeps).toEqual([12_000, 5_000]);
});

test("a 429 that asks for longer than the gate waits is answered at once and marks the hour's budget gone", async () => {
  const { clock, sleeps } = fakeClock();
  const gate = new BusinessmapGate(clock);
  const perform = jest
    .fn<Promise<Response>, []>()
    .mockResolvedValue(reply(429, {}, { error: { details: { retry_after: 900 } } }));
  expect((await gate.send(perform)).status).toBe(429);
  expect(perform).toHaveBeenCalledTimes(1);
  expect(sleeps).toEqual([]);
  expect(gate.saving()).toBe(true);
});

test("saving: background work stays out while the hour's budget is under the reserve, until that reading is old", async () => {
  const { clock, advance } = fakeClock();
  const gate = new BusinessmapGate(clock, { reserve: 100, staleMs: 600_000 });
  expect(gate.saving()).toBe(false);
  await gate.send(async () => reply(200, budget(20, 280)));
  expect(gate.saving()).toBe(false);
  await gate.send(async () => reply(200, budget(19, 99)));
  expect(gate.saving()).toBe(true);
  advance(599_999);
  expect(gate.saving()).toBe(true);
  advance(1);
  expect(gate.saving()).toBe(false);
});

test('read: identical reads in flight share one request; a cached answer is kept for its time; a failure is not kept', async () => {
  const { clock, advance } = fakeClock();
  const gate = new BusinessmapGate(clock);
  let release!: (v: string) => void;
  const slow = jest.fn(() => new Promise<string>((r) => (release = r)));
  const a = gate.read('k', slow, 1000);
  const b = gate.read('k', slow, 1000);
  release('tags');
  expect(await Promise.all([a, b])).toEqual(['tags', 'tags']);
  expect(slow).toHaveBeenCalledTimes(1);

  const again = jest.fn(async () => 'fresh');
  expect(await gate.read('k', again, 1000)).toBe('tags');
  advance(1000);
  expect(await gate.read('k', again, 1000)).toBe('fresh');
  expect(again).toHaveBeenCalledTimes(1);

  const failing = jest
    .fn<Promise<string>, []>()
    .mockRejectedValueOnce(new Error('HTTP 500'))
    .mockResolvedValueOnce('ok');
  await expect(gate.read('x', failing, 1000)).rejects.toThrow('HTTP 500');
  expect(await gate.read('x', failing, 1000)).toBe('ok');

  const uncached = jest.fn(async () => 'n');
  await gate.read('y', uncached);
  await gate.read('y', uncached);
  expect(uncached).toHaveBeenCalledTimes(2);
});

test('gateFor: one gate per board address and token', () => {
  const a = gateFor('https://bm.example', 'token-a');
  expect(gateFor('https://bm.example', 'token-a')).toBe(a);
  expect(gateFor('https://bm.example', 'token-b')).not.toBe(a);
  expect(gateFor('https://other.example', 'token-a')).not.toBe(a);
});
