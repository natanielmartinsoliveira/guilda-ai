import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const N = 2 ** 15,
  R = 8,
  P = 1,
  LENGTH = 32,
  MAXMEM = 64 * 1024 * 1024;
function derive(password: string, salt: Buffer, length: number, n: number, r: number, p: number) {
  return new Promise<Buffer>((done, fail) =>
    scrypt(password, salt, length, { N: n, r, p, maxmem: MAXMEM }, (error, key) =>
      error ? fail(error) : done(key),
    ),
  );
}
/** "scrypt:N:r:p:salt:hash" — ':' because '$' would be expanded when the .env is sourced. */
export async function hashPassword(password: string) {
  if (password.length < 12) throw new Error('Use at least 12 characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt, LENGTH, N, R, P);
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, n, r, p, salt, key] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  try {
    const actual = await derive(
      password,
      Buffer.from(salt, 'base64'),
      expected.length,
      Number(n),
      Number(r),
      Number(p),
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
