import { createHmac, timingSafeEqual } from 'node:crypto';
export function validSignature(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
