import { failingTests, onlyPreexisting } from '../src/tasks/test-failures';
test('the failing tests each usual runner names', () => {
  const phpunit = `There were 2 errors:\n\n1) Tests\\Unit\\OrderTest::test_restore\nArgumentCountError\n\n2) Tests\\Feature\\ApiTest::test_list with data set #1\n`;
  expect([...failingTests(phpunit)]).toEqual([
    'Tests\\Unit\\OrderTest::test_restore',
    'Tests\\Feature\\ApiTest::test_list',
  ]);
  expect([...failingTests('  ● orders › lists them\n  ● Console\n')]).toEqual([
    'orders › lists them',
  ]);
  expect([...failingTests(' FAIL  src/a.test.ts > a > b\n')]).toEqual(['src/a.test.ts > a > b']);
  expect([...failingTests('FAILED tests/test_a.py::test_b - AssertionError\n')]).toEqual([
    'tests/test_a.py::test_b',
  ]);
  expect([...failingTests('--- FAIL: TestBar (0.00s)\n')]).toEqual(['TestBar']);
  expect(failingTests('Segmentation fault').size).toBe(0);
});
test('only what already failed on the base is discounted; anything new, or unreadable, is a failure', () => {
  const base = ['Tests\\Unit\\OrderTest::test_restore'];
  const same = '1) Tests\\Unit\\OrderTest::test_restore\n';
  const more = `${same}2) Tests\\Unit\\EmailTest::test_valid\n`;
  expect(onlyPreexisting(same, base)).toEqual(base);
  expect(onlyPreexisting(more, base)).toBeUndefined();
  expect(onlyPreexisting('Fatal error: out of memory', base)).toBeUndefined();
  expect(onlyPreexisting(same, undefined)).toBeUndefined();
  expect(onlyPreexisting(same, [])).toBeUndefined();
});
