export const PER_IP = 5;
export const GLOBAL = 20;
export const WINDOW_MS = 15 * 60 * 1000;
/** Failed login attempts in memory (single API process): per IP, and all together. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  private recent(ip: string) {
    const since = this.now() - WINDOW_MS;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }
  blocked(ip: string) {
    if (this.recent(ip).length >= PER_IP) return true;
    let total = 0;
    for (const key of [...this.failures.keys()]) total += this.recent(key).length;
    return total >= GLOBAL;
  }
  fail(ip: string) {
    const list = this.recent(ip);
    list.push(this.now());
    this.failures.set(ip, list);
  }
  /** Gives back a reserved attempt (it turned out right). */
  refund(ip: string) {
    const list = this.recent(ip);
    list.pop();
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
  }
  reset(ip: string) {
    this.failures.delete(ip);
  }
}
