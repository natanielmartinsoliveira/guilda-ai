import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkMethod } from '../src/methods/check';
import { clearMethods } from '../src/methods/method';

const FIXTURES = resolve(__dirname, 'fixtures');
afterEach(() => clearMethods());

test('every prompt case of the method matches its expected text, and its own tests pass', async () => {
  const result = await checkMethod(FIXTURES, 'review-gate');
  expect(result.failures).toEqual([]);
  expect(result.cases).toBeGreaterThanOrEqual(29);
  expect(result.suites).toEqual(['tests/test_hooks.py: ok']);
});

test('a changed prompt is reported with the case and the first differing line (Review Focus)', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'method-check-'));
  await cp(join(FIXTURES, 'methods'), join(pack, 'methods'), { recursive: true });
  await rm(join(pack, 'methods/review-gate/tests/test_hooks.py'));
  await writeFile(join(pack, 'methods/review-gate/prompts/stop-option.md'), 'Go on');
  clearMethods();
  const result = await checkMethod(pack, 'review-gate');
  expect(result.failures).toEqual([
    expect.objectContaining({
      name: 'stop option',
      line: 1,
      expected: 'Continue the delivery',
      actual: 'Go on',
    }),
  ]);
  await rm(pack, { recursive: true, force: true });
});

test('a method without cases does not pass silently (Review Focus 5)', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'method-check-'));
  await cp(join(FIXTURES, 'methods'), join(pack, 'methods'), { recursive: true });
  await rm(join(pack, 'methods/review-gate/tests'), { recursive: true });
  clearMethods();
  await expect(checkMethod(pack, 'review-gate')).rejects.toThrow(/nenhum caso|no cases/);
  await rm(pack, { recursive: true, force: true });
});
