import { createHmac } from 'node:crypto';
import { validSignature } from '../src/webhooks/signature';
const body = Buffer.from('{"action":"opened"}'),
  secret = 'secret';
const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
test('validates the exact raw bytes', () => {
  expect(validSignature(body, signature, secret)).toBe(true);
  expect(validSignature(Buffer.from(body + ' '), signature, secret)).toBe(false);
});
test.each([undefined, '', 'sha256=zz', 'sha256=00', 'sha1=' + 'a'.repeat(64)])(
  'rejects malformed signature %s',
  (value) => expect(validSignature(body, value, secret)).toBe(false),
);
test('rejects wrong secret', () => expect(validSignature(body, signature, 'other')).toBe(false));
