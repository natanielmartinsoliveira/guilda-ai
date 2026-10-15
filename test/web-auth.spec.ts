import { hashPassword, verifyPassword } from '../src/web/password';
import { LoginLimiter } from '../src/web/limiter';
describe('password', () => {
  test('hash round-trips; wrong password or malformed hash is false; short is refused', async () => {
    const stored = await hashPassword('uma-senha-bem-longa');
    expect(stored).toMatch(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain('$');
    expect(await verifyPassword('uma-senha-bem-longa', stored)).toBe(true);
    expect(await verifyPassword('outra-senha-longa!', stored)).toBe(false);
    expect(await verifyPassword('uma-senha-bem-longa', 'lixo')).toBe(false);
    await expect(hashPassword('curta')).rejects.toThrow('12');
  });
});
describe('LoginLimiter', () => {
  test('5 failures block an IP for 15 minutes; success resets it', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 4; i++) limiter.fail('1.1.1.1');
    expect(limiter.blocked('1.1.1.1')).toBe(false);
    limiter.fail('1.1.1.1');
    expect(limiter.blocked('1.1.1.1')).toBe(true);
    expect(limiter.blocked('2.2.2.2')).toBe(false);
    now += 15 * 60 * 1000 + 1;
    expect(limiter.blocked('1.1.1.1')).toBe(false);
    limiter.fail('1.1.1.1');
    limiter.reset('1.1.1.1');
    expect(limiter.blocked('1.1.1.1')).toBe(false);
  });
  test('20 failures in total block everyone', () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < 20; i++) limiter.fail(`10.0.0.${i}`);
    expect(limiter.blocked('9.9.9.9')).toBe(true);
  });
});
import { DataSource } from 'typeorm';
import * as settings from '../src/config';
import { database } from './db';
import { clientIp, WebAuthService } from '../src/web/web-auth.service';
import { Notification, WebSession } from '../src/database/entities';
describe('WebAuthService', () => {
  let db: DataSource;
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword('senha-de-teste-123');
  });
  beforeEach(async () => {
    db = await database();
    jest.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_CHAT_ID: '123456789',
      WEB_PASSWORD_HASH: hash,
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });
  function setup(now = { value: Date.now() }) {
    const sent: string[] = [];
    class TestAuth extends WebAuthService {
      protected telegram() {
        return {
          sendMessage: async (_: string, text: string) => (sent.push(text), { messageId: '1' }),
        } as never;
      }
      protected clock() {
        return now.value;
      }
    }
    return { auth: new TestAuth(db), sent, now };
  }
  const codeOf = (text: string) => /(\d{6})/.exec(text)![1];
  test('password then Telegram code opens a session and warns about the new access', async () => {
    const x = setup();
    const { loginId } = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    expect(x.sent[0]).toContain('Código de acesso');
    const { token, expiresAt } = await x.auth.verify(
      loginId,
      codeOf(x.sent[0]),
      '1.1.1.1',
      'Firefox',
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime() - x.now.value).toBe(30 * 24 * 3600 * 1000);
    expect(await x.auth.session(token)).toMatchObject({ ip: '1.1.1.1', userAgent: 'Firefox' });
    // Only the hash is stored.
    expect(await db.getRepository(WebSession).findOneBy({ tokenHash: token })).toBeNull();
    expect(await db.getRepository(Notification).find()).toMatchObject([
      { kind: 'text', payload: { text: expect.stringContaining('Novo acesso ao front') } },
    ]);
    await x.auth.logout(token);
    expect(await x.auth.session(token)).toBeUndefined();
  });
  test('wrong password sends no code; 5 failures block the IP', async () => {
    const x = setup();
    for (let i = 0; i < 5; i++)
      await expect(x.auth.startLogin('errada-errada-123', '6.6.6.6')).rejects.toMatchObject({
        status: 401,
      });
    expect(x.sent).toEqual([]);
    await expect(x.auth.startLogin('senha-de-teste-123', '6.6.6.6')).rejects.toMatchObject({
      status: 429,
    });
  });
  test('a code is single-use, expires in 5 minutes and allows 5 tries', async () => {
    const x = setup();
    const first = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    const code = codeOf(x.sent[0]);
    await x.auth.verify(first.loginId, code, '1.1.1.1', 'ua');
    await expect(x.auth.verify(first.loginId, code, '1.1.1.1', 'ua')).rejects.toMatchObject({
      status: 401,
    });
    const second = await x.auth.startLogin('senha-de-teste-123', '2.2.2.2');
    x.now.value += 5 * 60 * 1000 + 1;
    await expect(
      x.auth.verify(second.loginId, codeOf(x.sent[1]), '2.2.2.2', 'ua'),
    ).rejects.toMatchObject({ status: 401 });
    const third = await x.auth.startLogin('senha-de-teste-123', '3.3.3.3');
    for (let i = 0; i < 5; i++)
      await expect(
        x.auth.verify(third.loginId, '000000', `4.4.4.${i}`, 'ua'),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      x.auth.verify(third.loginId, codeOf(x.sent[2]), '5.5.5.5', 'ua'),
    ).rejects.toMatchObject({ status: 401 });
  });
  test('expired and unknown sessions are not sessions', async () => {
    const x = setup();
    const { loginId } = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    const { token } = await x.auth.verify(loginId, codeOf(x.sent[0]), '1.1.1.1', 'ua');
    expect(await x.auth.session(undefined)).toBeUndefined();
    expect(await x.auth.session('nao-existe')).toBeUndefined();
    x.now.value += 30 * 24 * 3600 * 1000 + 1;
    expect(await x.auth.session(token)).toBeUndefined();
  });
  test('parallel wrong passwords cannot exceed the per-IP budget (review finding 2)', async () => {
    const x = setup();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => x.auth.startLogin('errada-errada-123', '7.7.7.7')),
    );
    const unauthorized = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 401,
    );
    expect(unauthorized.length).toBeLessThanOrEqual(5);
    expect(
      results.every(
        (r) =>
          r.status === 'rejected' && [401, 429].includes((r.reason as { status: number }).status),
      ),
    ).toBe(true);
  });
  test('parallel code guesses cannot exceed 5 tries; a code opens one session only (finding 3)', async () => {
    const x = setup();
    const a = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => x.auth.verify(a.loginId, '000000', `8.8.${i}.1`, 'ua')),
    );
    await expect(
      x.auth.verify(a.loginId, codeOf(x.sent[0]), '9.9.9.9', 'ua'),
    ).rejects.toMatchObject({
      status: 401,
    });
    const b = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    const twice = await Promise.allSettled([
      x.auth.verify(b.loginId, codeOf(x.sent[1]), '1.1.1.1', 'ua'),
      x.auth.verify(b.loginId, codeOf(x.sent[1]), '1.1.1.1', 'ua'),
    ]);
    expect(twice.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  test('changing the password or turning the front off ends every session (finding 4)', async () => {
    const x = setup();
    const { loginId } = await x.auth.startLogin('senha-de-teste-123', '1.1.1.1');
    const { token } = await x.auth.verify(loginId, codeOf(x.sent[0]), '1.1.1.1', 'ua');
    expect(await x.auth.session(token)).toBeDefined();
    const other = await hashPassword('nova-senha-trocada-1');
    jest
      .spyOn(settings, 'config')
      .mockReturnValue({ ...settings.config(), WEB_PASSWORD_HASH: other });
    expect(await x.auth.session(token)).toBeUndefined();
    jest.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      WEB_PASSWORD_HASH: hash,
      TELEGRAM_BOT_TOKEN: undefined,
    });
    expect(await x.auth.session(token)).toBeUndefined();
  });
  test('the front is off without a password hash', async () => {
    const x = setup();
    jest
      .spyOn(settings, 'config')
      .mockReturnValue({ ...settings.config(), WEB_PASSWORD_HASH: undefined });
    await expect(x.auth.startLogin('senha-de-teste-123', '1.1.1.1')).rejects.toMatchObject({
      status: 404,
    });
  });
});
describe('clientIp (finding 1)', () => {
  const req = (remote: string, xff?: string) =>
    ({
      socket: { remoteAddress: remote },
      ip: remote,
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
    }) as never;
  test('behind ngrok (loopback), the rightmost forwarded address is the client', () => {
    expect(clientIp(req('127.0.0.1', 'forged-1, 203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(req('::ffff:127.0.0.1', '203.0.113.8'))).toBe('203.0.113.8');
  });
  test('a direct connection is its own address, whatever it claims', () => {
    expect(clientIp(req('192.168.0.50', '1.2.3.4'))).toBe('192.168.0.50');
  });
});
