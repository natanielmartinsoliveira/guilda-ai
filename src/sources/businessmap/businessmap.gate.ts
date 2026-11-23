/** Time for the gate; tests pass one that only moves when the gate sleeps. */
export interface GateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: GateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GateOptions {
  /** Under this many requests left in the hour, background work (polls) stays out. */
  reserve: number;
  /** A budget reading older than this no longer keeps background work out. */
  staleMs: number;
  /** A 429 asking to wait longer than this is answered at once instead of holding the queue. */
  maxWaitMs: number;
  /** How long to wait once the minute's budget is gone. */
  minuteMs: number;
}

const DEFAULTS: GateOptions = {
  reserve: 100,
  staleMs: 10 * 60_000,
  maxWaitMs: 2 * 60_000,
  minuteMs: 60_000,
};

function count(value: string | null) {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** How long a 429 asks to wait, in ms: the Retry-After header or the body's `retry_after`. */
async function retryAfter(res: Response) {
  const header = count(res.headers.get('retry-after'));
  if (header !== undefined) return header * 1000;
  try {
    const body = (await res.clone().json()) as {
      error?: { details?: { retry_after?: unknown } };
    };
    const seconds = Number(body?.error?.details?.retry_after);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every call to one Businessmap account (address + API key) goes through one gate, because the
 * board limits the key, not the caller (requests per minute and per hour). The gate sends one
 * request at a time, waits when the minute's budget is gone, tries once more after a short 429,
 * lets identical reads share one request, and tells background work when to stay out so the
 * hour's last requests are left for what a person is waiting on.
 */
export class BusinessmapGate {
  private tail: Promise<unknown> = Promise.resolve();
  private minuteLeft?: number;
  private hourLeft?: number;
  private hourSeenAt = 0;
  private readonly reading = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, { until: number; value: unknown }>();
  private readonly options: GateOptions;

  constructor(
    private readonly clock: GateClock = realClock,
    options: Partial<GateOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Queues a request: it starts after the ones before it answered. */
  send(perform: () => Promise<Response>): Promise<Response> {
    const turn = this.tail.then(() => this.attempt(perform));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /**
   * A read by key: identical reads in flight share one request, and with `cacheMs` the answer is
   * kept that long. A failure is never kept.
   */
  read<T>(key: string, perform: () => Promise<T>, cacheMs = 0): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.until > this.clock.now()) return Promise.resolve(hit.value as T);
    const pending = this.reading.get(key);
    if (pending) return pending as Promise<T>;
    const request = perform()
      .then((value) => {
        if (cacheMs > 0) this.cache.set(key, { until: this.clock.now() + cacheMs, value });
        return value;
      })
      .finally(() => this.reading.delete(key));
    this.reading.set(key, request);
    return request;
  }

  /** True while the hour's budget is under the reserve (a reading that is not too old). */
  saving() {
    return (
      this.hourLeft !== undefined &&
      this.hourLeft < this.options.reserve &&
      this.clock.now() - this.hourSeenAt < this.options.staleMs
    );
  }

  private async attempt(perform: () => Promise<Response>) {
    if (this.minuteLeft !== undefined && this.minuteLeft <= 1) {
      await this.clock.sleep(this.options.minuteMs);
      this.minuteLeft = undefined;
    }
    const first = await perform();
    this.note(first);
    if (first.status !== 429) return first;
    const wait = await retryAfter(first);
    if (wait === undefined || wait > this.options.maxWaitMs) {
      // A long wait is the hour's budget: background work stays out until it comes back.
      this.hourLeft = 0;
      this.hourSeenAt = this.clock.now();
      return first;
    }
    await this.clock.sleep(wait);
    const second = await perform();
    this.note(second);
    return second;
  }

  private note(res: Response) {
    const minute = count(res.headers.get('x-ratelimit-perminute-remaining'));
    const hour = count(res.headers.get('x-ratelimit-perhour-remaining'));
    if (minute !== undefined) this.minuteLeft = minute;
    if (hour !== undefined) {
      this.hourLeft = hour;
      this.hourSeenAt = this.clock.now();
    }
  }
}

const gates = new Map<string, BusinessmapGate>();

/** The gate of one Businessmap account, shared by every client of this process. */
export function gateFor(baseUrl: string, token: string) {
  const key = `${baseUrl}\u0000${token}`;
  let gate = gates.get(key);
  if (!gate) gates.set(key, (gate = new BusinessmapGate()));
  return gate;
}
