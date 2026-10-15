/** How far back each poll looks, so a row committed late (old timestamp) is not missed. */
export const OVERLAP_MS = 5000;
export interface FeedRow {
  type: string;
  id: string;
  updatedAt: Date;
}
/**
 * What one SSE connection still has to send. Each poll looks back OVERLAP_MS (late commits:
 * updatedAt is the transaction start), and rows already sent with the same timestamp are
 * dropped (PostgreSQL keeps microseconds, JS dates do not: `updatedAt > since` would match the
 * newest row again on every tick).
 */
export class ChangeFeed {
  private latest: number;
  private readonly sent = new Map<string, number>();
  constructor(start: Date) {
    this.latest = start.getTime();
  }
  since() {
    return new Date(this.latest - OVERLAP_MS);
  }
  take<T extends FeedRow>(rows: T[]): T[] {
    const fresh: T[] = [];
    for (const row of rows) {
      const key = `${row.type}:${row.id}`;
      const ms = row.updatedAt.getTime();
      if (this.sent.get(key) === ms) continue;
      this.sent.set(key, ms);
      fresh.push(row);
      if (ms > this.latest) this.latest = ms;
    }
    // Rows older than two windows can no longer come back.
    const cutoff = this.latest - OVERLAP_MS * 2;
    for (const [key, ms] of this.sent) if (ms < cutoff) this.sent.delete(key);
    return fresh;
  }
  size() {
    return this.sent.size;
  }
}
