import { authText } from './auth-text';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { config, log } from '../config';
import { Notification, WebLogin, WebSession } from '../database/entities';
import { telegramEnabled } from '../telegram/enabled';
import { TelegramClient } from '../telegram/telegram.client';
import { LoginLimiter } from './limiter';
import { verifyPassword } from './password';
export const SESSION_COOKIE = 'adt_session';
const CODE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TRIES = 5;
/** Password checks (scrypt, ~32 MiB each) allowed at once; more is refused, not queued. */
const MAX_CHECKS = 2;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
export class WebAuthError extends Error {
  constructor(
    readonly status: 401 | 404 | 429,
    message: string,
  ) {
    super(message);
  }
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** The front exists only with a password hash and Telegram (the second factor). */
export function webEnabled() {
  return !!config().WEB_PASSWORD_HASH && telegramEnabled();
}
export function readCookie(header: string | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
/**
 * Behind ngrok every connection comes from loopback and the client is the address ngrok
 * appended last to X-Forwarded-For (anything before it was sent by the client and can be
 * forged). A direct connection is its own address, whatever header it sends.
 */
export function clientIp(req: Request) {
  const remote = req.socket?.remoteAddress ?? req.ip ?? 'unknown';
  if (!LOOPBACK.test(remote)) return remote;
  const forwarded = (req.get('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? remote;
}
/** Sessions belong to the password they were opened with: changing it ends them all. */
function passwordTag() {
  return sha256(config().WEB_PASSWORD_HASH ?? '').slice(0, 32);
}
/** Two-step login (password, then a code over Telegram) and cookie sessions for the front. */
@Injectable()
export class WebAuthService {
  private readonly limiter = new LoginLimiter(() => this.clock());
  private checking = 0;
  constructor(private readonly db: DataSource) {}
  /** Overridable in tests. */
  protected telegram() {
    return new TelegramClient(config().TELEGRAM_BOT_TOKEN!);
  }
  /** Overridable in tests. */
  protected clock() {
    return Date.now();
  }
  private guard(ip: string) {
    if (!webEnabled()) throw new WebAuthError(404, authText('off'));
    if (this.limiter.blocked(ip)) throw new WebAuthError(429, authText('tooMany'));
  }
  private fail(ip: string, step: string) {
    this.limiter.fail(ip);
    log('web.login_failed', { ip, step });
    return new WebAuthError(401, authText('invalid'));
  }
  async startLogin(password: string, ip: string) {
    this.guard(ip);
    if (this.checking >= MAX_CHECKS) throw new WebAuthError(429, authText('tooManyNow'));
    // Reserved before the (slow) check, so parallel requests cannot all get in.
    this.limiter.fail(ip);
    this.checking++;
    let right = false;
    try {
      right = await verifyPassword(password, config().WEB_PASSWORD_HASH!);
    } finally {
      this.checking--;
    }
    if (!right) {
      log('web.login_failed', { ip, step: 'password' });
      throw new WebAuthError(401, authText('invalid'));
    }
    this.limiter.refund(ip);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const login = await this.db.getRepository(WebLogin).save({
      codeHash: sha256(code),
      expiresAt: new Date(this.clock() + CODE_TTL_MS),
      attempts: 0,
      ip,
    });
    await this.telegram().sendMessage(config().TELEGRAM_CHAT_ID!, authText('code', { code }));
    return { loginId: login.id };
  }
  async verify(loginId: string, code: string, ip: string, userAgent: string) {
    this.guard(ip);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(loginId))
      throw this.fail(ip, 'code');
    // Each try is counted atomically before comparing: parallel guesses share the 5 tries.
    const counted = await this.db
      .createQueryBuilder()
      .update(WebLogin)
      .set({ attempts: () => 'attempts + 1' })
      .where('id = :id AND attempts < :max AND "usedAt" IS NULL AND "expiresAt" > :now', {
        id: loginId,
        max: CODE_TRIES,
        now: new Date(this.clock()),
      })
      .execute();
    if (counted.affected !== 1) throw this.fail(ip, 'code');
    const login = await this.db.getRepository(WebLogin).findOneByOrFail({ id: loginId });
    if (!timingSafeEqual(Buffer.from(sha256(String(code))), Buffer.from(login.codeHash)))
      throw this.fail(ip, 'code');
    // Single use, atomically: of two simultaneous right answers, one opens the session.
    const used = await this.db
      .createQueryBuilder()
      .update(WebLogin)
      .set({ usedAt: new Date(this.clock()) })
      .where('id = :id AND "usedAt" IS NULL', { id: loginId })
      .execute();
    if (used.affected !== 1) throw this.fail(ip, 'code');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.clock() + SESSION_TTL_MS);
    await this.db.getRepository(WebSession).save({
      tokenHash: sha256(token),
      passwordTag: passwordTag(),
      expiresAt,
      ip,
      userAgent: userAgent.slice(0, 300),
      lastSeenAt: new Date(this.clock()),
    });
    this.limiter.reset(ip);
    if (telegramEnabled())
      await this.db.getRepository(Notification).save({
        kind: 'text',
        payload: {
          text: authText('newAccess', { ip, agent: userAgent.slice(0, 120) }),
        },
      });
    log('web.login', { ip });
    return { token, expiresAt };
  }
  async session(token: string | undefined) {
    if (!token || !webEnabled()) return undefined;
    const session = await this.db.getRepository(WebSession).findOneBy({ tokenHash: sha256(token) });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() < this.clock() ||
      session.passwordTag !== passwordTag()
    )
      return undefined;
    return session;
  }
  async logout(token: string | undefined) {
    if (!token) return;
    await this.db
      .getRepository(WebSession)
      .update({ tokenHash: sha256(token) }, { revokedAt: new Date(this.clock()) });
  }
}
